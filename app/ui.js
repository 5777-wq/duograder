// DuoGrader 网页版编排层：预检 → 双盲 → 校验（一次打回） → 合并/仲裁 → 渲染 → 历史归档
import {
  precheck, countWords, parseModelJSON, validateReport, mergeSameBand, dualRail,
  graderMessages, arbiterMessages, repairMessages, callChat, transcriptionMessages, detectTaskType,
  probeCors, fetchModelList, chatTestMessages, visionTestMessages, httpErrorHint, PRESETS, RECOMMENDED, STATUS_LABEL,
  detectProviderByKey, keyLooksMismatched,
} from './core.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TRACKS = { 'english-i': '英语一', 'english-ii': '英语二' };
const TASKS = { large: '大作文 Part B', small: '小作文 Part A' };
const LENGTH_HINT = {
  ok: ['达标', 'ok'], soft_ok: ['基本达标', 'ok'], soft_short: ['略短（不罚分，建议补足）', 'soft'],
  short_two_thirds: ['字数不足 2/3（任务完成分减半，封顶第三档）', 'bad'],
  short_half: ['字数不足一半（封顶第二档）', 'bad'],
};

const state = { track: 'english-ii', task: 'large', rubric: null, schema: null, kernel: null, busy: false, settings: null, photos: [], transcribed: false, confirmed: false };

/* ---------- 初始化 ---------- */
async function init() {
  loadSettings();
  staggerCards(document.querySelector('.wrap'), 50);
  // 入场动画的总开关：双 rAF 确认浏览器真的在推进动画时钟后才启用。
  // 标签页在后台打开时动画时钟会被冻结，若无脑给主体内容上 fill-mode:both 的
  // 入场动画，内容会一直卡在 opacity 0 —— 白屏比没有淡入严重得多。
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('anim-ok')));
  bindSeg('seg-track', 'track');
  bindSeg('seg-task', 'task');
  $('essay-in').addEventListener('input', updateCountBar);
  $('btn-grade').addEventListener('click', () => {
    // 批改中再点 = 取消（中止进行中的 API 请求）
    if (state.busy && state.abort) { state.abort.abort(); return; }
    runPipeline();
  });
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-history').addEventListener('click', openDrawer);
  // 邀请码登录（内置算力模式）
  $('btn-login').addEventListener('click', openLogin);
  $('btn-login-close').addEventListener('click', closeLogin);
  $('login-mask').addEventListener('click', closeLogin);
  $('btn-login-save').addEventListener('click', saveLogin);
  $('btn-drawer-close').addEventListener('click', closeDrawer);
  $('drawer-mask').addEventListener('click', closeDrawer);
  $('modal-mask').addEventListener('click', closeSettings);
  $('btn-settings-close').addEventListener('click', closeSettings);
  $('btn-diag').addEventListener('click', async () => {
    // 测通了才存——新手不该在配置错误的状态下被"保存成功"误导
    const ok = await runDiagnostics();
    if (ok) saveSettings({ message: '✓ 测通了，设置已保存。可以开始批改了。' });
  });
  $('btn-save').addEventListener('click', () => saveSettings());
  // 自定义供应商下拉（原生 select 样式不可控，弃用）
  const provBtn = $('prov-btn'), provList = $('prov-list');
  provBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    renderProvList(state.preset || 'deepseek');
    provList.hidden = !provList.hidden;
  });
  provList.addEventListener('click', (e) => {
    const row = e.target.closest('.prov-row');
    if (!row) return;
    e.stopPropagation();
    const id = row.dataset.id;
    provList.hidden = true;
    // 邀请码模式不在这里配 Key——直接把人送去登录框
    if (id === 'invite') { closeSettings(); openLogin(); return; }
    state.preset = id;
    applyPreset(id);
    paintProvInfo(id);
    setAdvanced(id === 'custom');
    if (id === 'custom') $('set-base').focus();
  });
  document.addEventListener('click', () => { provList.hidden = true; });
  $('adv-toggle').addEventListener('click', () => setAdvanced($('adv-fields').hidden));
  // 贴 Key → 按前缀自动认供应商（只认前缀唯一的；国内几家都是 sk- 开头就不乱猜）
  let keyTimer = null;
  $('set-key').addEventListener('input', () => {
    paintKeyHint();
    clearTimeout(keyTimer);
    keyTimer = setTimeout(autoPickByKey, 140);
  });
  $('btn-eye').addEventListener('click', () => {
    const inp = $('set-key');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('btn-eye').textContent = show ? '隐藏' : '显示';
  });
  // 三条上手路径
  $('start-paths').addEventListener('click', (e) => {
    const card = e.target.closest('.path-card');
    if (!card) return;
    const path = card.dataset.path;
    if (path === 'invite') { closeSettings(); openLogin(); }
    else if (path === 'byok') { $('set-key').focus(); $('set-key').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else if (path === 'local') {
      state.preset = 'ollama';
      applyPreset('ollama');
      paintProvInfo('ollama');
      setAdvanced(false);
      setKeyHint('选了 Ollama 本地模型：先在电脑上装好 Ollama 并拉一个模型（ollama pull qwen2.5:7b），Key 留空即可。手机打不开本地服务是正常的。', 'hint warn');
    }
  });
  $('file-cam').addEventListener('change', (e) => handleFiles(e.target.files, e.target));
  $('file-gal').addEventListener('change', (e) => handleFiles(e.target.files, e.target));
  // APK 内：input 的 capture 属性会被 WebView 退化成文件选择器，改走原生相机插件
  if (window.Capacitor?.isNativePlatform?.()) {
    document.querySelector('.cam-btn').addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const photo = await window.Capacitor.Plugins.Camera.getPhoto({
          quality: 85, resultType: 'DataUrl', source: 'CAMERA', width: 1568, saveToGallery: false,
        });
        state.photos.push(photo.dataUrl);
        renderThumbs();
      } catch (err) {
        if (!/cancel/i.test(String(err?.message || ''))) banner('相机启动失败：' + (err?.message || err), 'bad');
      }
    });
  }
  $('btn-transcribe-all').addEventListener('click', () => transcribe());
  bindCrop();
  $('btn-fetch-models').addEventListener('click', () => fetchModels());
  // 核对确认闸门：转写过就必须勾选确认，批改按钮才解锁
  $('confirm-check').addEventListener('change', (e) => {
    state.confirmed = e.target.checked;
    updateGradeGate();
  });
  // 拖拽导入：主卡为投放区，整页阻止浏览器默认打开文件
  const dropCard = document.querySelector('.main-card');
  ['dragenter', 'dragover'].forEach((ev) => dropCard.addEventListener(ev, (e) => { e.preventDefault(); dropCard.classList.add('dragging'); }));
  dropCard.addEventListener('dragleave', (e) => { if (!dropCard.contains(e.relatedTarget)) dropCard.classList.remove('dragging'); });
  dropCard.addEventListener('drop', (e) => { e.preventDefault(); dropCard.classList.remove('dragging'); handleFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  // 手动打题面时也实时识别（用户手点过题型后不再自动改）
  let detectTimer = null;
  $('prompt-in').addEventListener('input', () => {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => applyDetection(false), 500);
  });
  fillSettingsForm();
  updateLoginBtn();
  updateCountBar();
  histMigrate().then(renderHistory);
  syncTranscribeBtn();
  try {
    const P = '../skill/kaoyan-essay/prompts/';
    [state.rubric, state.schema, state.kernel] = await Promise.all([
      fetch('../skill/kaoyan-essay/rubrics/writing-rubric.md').then((r) => { if (!r.ok) throw 0; return r.text(); }),
      fetch('../skill/kaoyan-essay/schema/grading-report.schema.json').then((r) => { if (!r.ok) throw 0; return r.text(); }),
      Promise.all([
        fetch(P + 'grader-system.md').then((r) => { if (!r.ok) throw 0; return r.text(); }),
        fetch(P + 'grader-task.md').then((r) => { if (!r.ok) throw 0; return r.text(); }),
        fetch(P + 'arbiter-task.md').then((r) => { if (!r.ok) throw 0; return r.text(); }),
      ]).then(([gs, gt, at]) => ({ graderSystem: gs, graderTask: gt, arbiterTask: at })),
    ]);
  } catch {
    state.kernel = null; // core.js 内置提示词兜底
    banner('评分规则加载失败：请从仓库根目录启动本地服务器（python -m http.server 8650），再访问 /app/', 'bad');
  }
}

function banner(text, kind = 'bad') {
  $('banner-area').innerHTML = `<div class="banner ${kind === 'info' ? 'info' : ''}">${esc(text)}</div>`;
}

/* ---------- 分段选择 / 字数条 ---------- */
function bindSeg(id, key) {
  $(id).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    $(id).querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    state[key] = b.dataset.v;
    updateCountBar();
  }));
}
function setSeg(id, value, key) {
  $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === value));
  state[key] = value;
  updateCountBar();
}
// —— 科目/题型识别落点：把识别结果写进分段选择并展示依据。识别只是预填，用户随时可点改。
function applyDetectResult({ task, track, evidence }) {
  const t = ['large', 'small'].includes(task) ? task : null;
  const tr = ['english-i', 'english-ii'].includes(track) ? track : null;
  if (!t && !tr) return false;
  if (tr) setSeg('seg-track', tr, 'track');
  if (t) setSeg('seg-task', t, 'task');
  const note = $('detect-note');
  note.hidden = false;
  if (tr) {
    note.textContent = `✓ 已自动识别：${TRACKS[state.track]} · ${TASKS[state.task]}${evidence ? `（依据：${evidence}）` : ''}。如识别有误，点选上方即可修改。`;
  } else {
    // 小作文英一英二都是"约100词/10分"，题面文本里没有科目硬信号——不能谎称已识别科目。
    // 真题年份比对是 skill 侧的独有能力，网页端只能请用户自己确认。
    note.textContent = `✓ 已自动识别题型：${TASKS[state.task]}${evidence ? `（依据：${evidence}）` : ''}。小作文题面无科目硬信号，**英语一/英语二请点上方手动确认**（判错科目会连分值制一起错）。`;
  }
  return true;
}
// —— 大/小作文与科目自动识别（依据题面词数/分值/体裁，转写或输入后触发）。
// 手动点选不会被输入事件触发，因此手动修正天然稳定；新的题面输入到来时以证据为准再次纠正。
function applyDetection(announce) {
  const d = detectTaskType($('prompt-in').value);
  if (!d.task) return;
  const changed = d.task !== state.task || (d.track && d.track !== state.track);
  if (d.track) setSeg('seg-track', d.track, 'track');
  setSeg('seg-task', d.task, 'task');
  const note = $('detect-note');
  if (changed || announce) {
    note.hidden = false;
    note.textContent = `✓ 已自动识别：${TRACKS[state.track]} · ${TASKS[state.task]}（依据：${d.evidence.join('；')}）。如识别有误，点选上方即可修改。`;
  }
}
function updateCountBar() {
  const text = $('essay-in').value;
  const n = countWords(text);
  const [lo, hi] = RECOMMENDED[`${state.track}_${state.task}`];
  const [hint, cls] = LENGTH_HINT[n >= lo ? 'ok' : n >= 0.8 * lo ? 'soft_ok' : n >= lo * 2 / 3 ? 'soft_short' : n >= 0.5 * lo ? 'short_two_thirds' : 'short_half'];
  $('count-bar').innerHTML = text.trim()
    ? `<b>${n}</b> 词 · 建议 ${lo === hi ? `约 ${lo}` : `${lo}–${hi}`} 词 · <span class="pill ${cls}">${hint}</span>`
    : `<span style="color:#a8a49a">建议字数 ${lo === hi ? `约 ${lo}` : `${lo}–${hi}`} 词</span>`;
}

/* ---------- 邀请码登录（内置算力模式） ---------- */
function updateLoginBtn() {
  const s = state.settings;
  $('btn-login').textContent = s?.preset === 'invite' && s.apiKey ? '已登录' : '登录';
}
function openLogin() {
  $('login-code').value = state.settings?.preset === 'invite' ? state.settings.apiKey || '' : '';
  $('login-result').textContent = '';
  $('modal-login').classList.add('show');
  $('login-mask').classList.add('show');
  $('login-code').focus();
}
function closeLogin() {
  $('modal-login').classList.remove('show');
  $('login-mask').classList.remove('show');
}
async function saveLogin() {
  const code = $('login-code').value.trim();
  if (!code) { $('login-result').textContent = '请输入邀请码。'; return; }
  const p = PRESETS.find((x) => x.id === 'invite');
  const btn = $('btn-login-save');
  btn.disabled = true; btn.textContent = '验证中…';
  $('login-result').textContent = '';
  try {
    // 先真实调用一次验证邀请码，通过才保存
    await callChat({ baseURL: p.baseURL, apiKey: code, model: p.model }, chatTestMessages(), { temperature: 0 });
    state.settings = { preset: 'invite', baseURL: p.baseURL, model: p.model, vmodel: p.vmodel || '', apiKey: code };
    localStorage.setItem('duograder_settings_v1', JSON.stringify(state.settings));
    $('btn-settings').textContent = '设置 ●';
    updateLoginBtn();
    closeLogin();
    banner('已登录：批改与拍照转写都将使用内置算力。', 'info');
    setTimeout(() => { $('banner-area').innerHTML = ''; }, 2500);
  } catch (e) {
    $('login-result').textContent = '邀请码验证失败：' + shortErr(e.message);
  } finally {
    btn.disabled = false; btn.textContent = '登录';
  }
}

/* ---------- 设置 ---------- */
function loadSettings() {
  try { state.settings = JSON.parse(localStorage.getItem('duograder_settings_v1')) || null; } catch { state.settings = null; }
  // 邀请码模式迁移：代理地址更新后（如 workers.dev → pages.dev 同域），旧登录自动切到最新预设地址
  const p = PRESETS.find((x) => x.id === 'invite');
  if (state.settings?.preset === 'invite' && p && state.settings.baseURL !== p.baseURL) {
    state.settings = { ...state.settings, baseURL: p.baseURL, model: p.model, vmodel: p.vmodel || '' };
    localStorage.setItem('duograder_settings_v1', JSON.stringify(state.settings));
  }
  // 免费额度模式：新访客默认走内置算力匿名通道（不写 localStorage，首次保存设置才落盘）
  if (!state.settings && p) {
    state.settings = { preset: 'invite', baseURL: p.baseURL, model: p.model, vmodel: p.vmodel || '', apiKey: '' };
  }
  if (state.settings) $('btn-settings').textContent = '设置 ●';
}

/* ---------- 免费额度角标（每 IP 50 次，内置算力） ---------- */
function paintFree(n) {
  const el = $('free-quota');
  if (!el || typeof n !== 'number') return;
  el.hidden = false;
  el.textContent = '免费 ' + Math.max(0, n) + '/50';
}
window.addEventListener('dg-free', (e) => paintFree(e.detail));
async function refreshFreeQuota() {
  // 邀请码已登录 = 不限次，不显示免费角标
  if (state.settings?.preset === 'invite' && state.settings.apiKey) return;
  try {
    let did = '';
    try { did = localStorage.getItem('duograder_did') || ''; } catch {}
    const p = PRESETS.find((x) => x.id === 'invite');
    const res = await fetch(p.baseURL + '/quota', did ? { headers: { 'X-Device-Id': did } } : {});
    if (!res.ok) return;
    const j = await res.json();
    if (typeof j.remaining === 'number') paintFree(j.remaining);
  } catch {}
}
function applyPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  $('set-base').value = p.baseURL;
  $('set-model').value = p.model;
  $('set-vmodel').value = p.vmodel || '';
}
function setAdvanced(show) {
  $('adv-fields').hidden = !show;
  $('adv-toggle').querySelector('.adv-arrow').textContent = show ? '▾' : '▸';
}

/* ---------- 供应商选择器：说清"选哪个"和"去哪儿拿 Key" ---------- */
const STATUS_CLASS = { ok: 'ok', blocked: 'bad', local: 'mut' };

function renderProvList(currentId) {
  // 邀请码不在这里：它是"登录"模式（右上角登录 / 不想折腾那条路径），不是可配置的 BYOK 供应商
  $('prov-list').innerHTML = PRESETS.filter((p) => p.id !== 'invite').map((p) => `
    <button type="button" class="prov-row ${p.id === currentId ? 'on' : ''}" data-id="${p.id}">
      <span class="p-main">
        <span class="p-name">${esc(p.name)}</span>
        ${p.status ? `<span class="p-status ${STATUS_CLASS[p.status]}">${esc(STATUS_LABEL[p.status])}</span>` : ''}
      </span>
      ${p.blurb ? `<span class="p-blurb">${esc(p.blurb)}</span>` : ''}
      ${p.note ? `<span class="p-note">⚠ ${esc(p.note)}</span>` : ''}
    </button>`).join('');
}

// 当前供应商的说明、状态徽章、申请 Key 链接、Key 提示
function paintProvInfo(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  $('prov-current').textContent = p.name;
  const st = $('prov-status');
  if (p.status) {
    st.hidden = false;
    st.className = 'p-status ' + STATUS_CLASS[p.status];
    st.textContent = STATUS_LABEL[p.status];
  } else {
    st.hidden = true;
  }
  $('prov-blurb').textContent = p.blurb || '';
  const link = $('key-link');
  if (p.keyUrl) {
    link.hidden = false;
    link.href = p.keyUrl;
    link.textContent = '去 ' + p.name.replace(/ 官方| · 内置算力| 本地/g, '') + ' 控制台申请 Key →';
  } else {
    link.hidden = true;
  }
  paintKeyHint();
}

// Key 提示：格式与所选供应商对不上时给软提示（绝不拦——猜错不该阻断可用配置）
function setKeyHint(text, cls = 'hint') {
  const el = $('key-hint');
  if (!el) return;
  el.textContent = text;
  el.className = cls;
}
function paintKeyHint(note) {
  const key = $('set-key').value.trim();
  const p = PRESETS.find((x) => x.id === state.preset);
  if (note) { setKeyHint(note, 'hint ok'); return; }
  if (!key) {
    setKeyHint(p?.status === 'local'
      ? '本地模型一般不需要 Key（留空即可）'
      : '粘贴后会自动填好地址与模型，再点「试一下」验证');
    return;
  }
  const bad = keyLooksMismatched(state.preset, key);
  if (bad) {
    setKeyHint(`⚠ 这个 Key 看起来不像 ${bad} 的（你当前选的是 ${p?.name || '自定义'}）。确认下供应商选对了？`, 'hint warn');
    return;
  }
  setKeyHint(p?.keyRe ? `✓ 格式与 ${p.name} 匹配` : 'Key 已填，点「试一下」验证', 'hint ok');
}

// 贴 Key 自动认供应商：只认前缀唯一的，国内几家都是 sk- 开头就不乱猜
function autoPickByKey() {
  const id = detectProviderByKey($('set-key').value);
  if (!id || id === state.preset) return;
  const p = PRESETS.find((x) => x.id === id);
  state.preset = id;
  applyPreset(id);
  paintProvInfo(id);
  setAdvanced(false);
  paintKeyHint(`✓ 已按 Key 认出是「${p.name}」，地址和模型都填好了`);
}

// 模型名纠错： cur 为空 → 取列表第一个；完全匹配 → 不动；模糊包含 → 用匹配项；否则 null（保留原值）
function bestModelMatch(cur, ids) {
  if (!ids.length) return null;
  if (!cur) return ids[0];
  const low = ids.map((i) => i.toLowerCase());
  const c = cur.toLowerCase();
  if (low.includes(c)) return null;
  const idx = low.findIndex((id) => id.includes(c) || c.includes(id));
  return idx >= 0 ? ids[idx] : null;
}
// 把拉到的列表写进下拉并自动纠正两个模型框，返回纠正说明
function syncModelLists(ids) {
  const dl = $('dl-models'), dv = $('dl-vmodels');
  dl.innerHTML = ''; dv.innerHTML = '';
  for (const id of ids) { dl.insertAdjacentHTML('beforeend', `<option value="${esc(id)}"></option>`); dv.insertAdjacentHTML('beforeend', `<option value="${esc(id)}"></option>`); }
  const fixes = [];
  const m = bestModelMatch($('set-model').value.trim(), ids);
  if (m) { fixes.push('主模型→' + m); $('set-model').value = m; }
  const v = $('set-vmodel').value.trim();
  const vFix = bestModelMatch(v, ids);
  if (vFix) { fixes.push('视觉模型→' + vFix); $('set-vmodel').value = vFix; }
  return fixes;
}

function fillSettingsForm() {
  const s = state.settings || {};
  // 这个弹窗只管"自带 Key"的配置。邀请码/匿名模式在登录里，不在这里配。
  const presetId = (s.preset && s.preset !== 'invite') ? s.preset : 'deepseek';
  state.preset = presetId;
  if (!s.baseURL || s.preset === 'invite') {
    // 从未保存过（或当前是邀请码模式）：预设默认生效并预填字段——用户只需粘一个 key
    applyPreset(presetId);
  } else {
    $('set-base').value = s.baseURL;
    $('set-model').value = s.model || '';
    $('set-vmodel').value = s.vmodel || '';
  }
  // 邀请码模式下 apiKey 存的是邀请码，不是 API Key —— 别把它当 Key 显示出来
  $('set-key').value = (s.preset === 'invite') ? '' : (s.apiKey || '');
  setAdvanced(presetId === 'custom');
  paintProvInfo(presetId);
}
function openSettings() {
  $('modal-settings').classList.add('show'); $('modal-mask').classList.add('show');
  fillSettingsForm();
  $('diag-result').innerHTML = '';
  $('models-result').textContent = '';
}
function closeSettings() { $('modal-settings').classList.remove('show'); $('modal-mask').classList.remove('show'); }
function saveSettings(opts = {}) {
  const preset = state.preset || 'deepseek';
  const key = $('set-key').value.trim();
  const isLocal = PRESETS.find((x) => x.id === preset)?.status === 'local';
  // 没填 Key 又不是本地模型：存下来也是一份坏配置，别让新手以为配好了
  if (!key && !isLocal) {
    banner('还没填 API Key —— 贴上再保存；或者点上面的「不想折腾」用内置算力。', 'bad');
    return;
  }
  state.settings = {
    preset,
    baseURL: $('set-base').value.trim(), model: $('set-model').value.trim(),
    apiKey: key, vmodel: $('set-vmodel').value.trim(),
  };
  localStorage.setItem('duograder_settings_v1', JSON.stringify(state.settings));
  $('btn-settings').textContent = state.settings.baseURL && (state.settings.apiKey || state.settings.preset === 'ollama' || state.settings.preset === 'lmstudio') ? '设置 ●' : '设置';
  updateLoginBtn();
  if (opts.keepOpen) return;
  closeSettings();
  banner(opts.message || '设置已保存。', 'info');
  setTimeout(() => { $('banner-area').innerHTML = ''; }, 2500);
}
/* 试一下（仿主流 harness 的 connection check）：直连探测 → 模型列表 → 主模型对话 → 视觉模型真图测试
   每一项失败都给"怎么办"——新手最需要的是下一步动作，不是错误码。
   返回 true = 主链路可用，可以保存。 */
async function runDiagnostics() {
  const base = $('set-base').value.trim().replace(/\/+$/, '');
  const key = $('set-key').value.trim();
  let model = $('set-model').value.trim();
  let vmodel = $('set-vmodel').value.trim();
  const box = $('diag-result');
  const preset = PRESETS.find((x) => x.id === state.preset);
  const isLocal = preset?.status === 'local';
  if (!base) { box.innerHTML = diagLine(false, '① 浏览器直连', '还没填地址', '先在上面选一个供应商，地址会自动填好'); return false; }

  const btn = $('btn-diag');
  btn.disabled = true; btn.textContent = '测试中…';
  const lines = [];
  const push = (ok, name, detail, fix) => { lines.push(diagLine(ok, name, detail, fix)); box.innerHTML = lines.join(''); };

  // 0. Key 与所选供应商是否对得上（软提示，不拦）
  const bad = keyLooksMismatched(state.preset, key);
  if (bad) {
    push(false, '⓪ Key 格式', `这个 Key 看起来不像 ${bad} 的`,
      `你当前选的是「${preset?.name || '自定义'}」。若确实要用这把 Key，把上面的供应商改成 ${bad}；若要换 Key，先把供应商改对。`);
  }

  // 1. 直连探测（无需 key：能读到任何 HTTP 状态码即证明浏览器可跨域直连）
  push(null, '① 浏览器直连', '探测中…');
  const probe = await probeCors(base);
  if (probe.ok) {
    const readable = probe.status < 500;
    push(readable, '① 浏览器直连', `可直连（HTTP ${probe.status} · ${probe.ms}ms）${probe.status === 401 ? '——401 属正常，未填 key' : ''}`);
    if (!readable) { finish(false); return false; }
  } else {
    const fix = isLocal
      ? '本地模型要先跑起来：Ollama 执行 `ollama serve` 再 `ollama pull qwen2.5:7b`；LM Studio 要在设置里打开 Local Server。手机打不开是正常的。'
      : preset?.status === 'blocked'
        ? '这家浏览器直连被拦。用「桌面壳」跑（cd app && npm start），或让对方给你一个反代地址，填进高级设置的 Base URL。'
        : '多半是网络问题，或这家拦跨域。换一家试试（DeepSeek 便宜且国内直连），或改用桌面壳。';
    push(false, '① 浏览器直连', `${probe.error}（${probe.ms}ms）`, fix);
    finish(false); return false;
  }

  // 2. 模型列表（用真 key）+ 模型名自动纠正
  if (!key && !isLocal) { push(false, '② 模型列表', '没填 API Key，跳过后续检查', '把 Key 贴到上面的输入框；本地模型才不用 Key'); finish(false); return false; }
  push(null, '② 模型列表', '拉取中…');
  let knownIds = null;
  try {
    knownIds = await fetchModelList({ baseURL: base, apiKey: key });
    const fixes = syncModelLists(knownIds);
    model = $('set-model').value.trim(); vmodel = $('set-vmodel').value.trim();
    push(true, '② 模型列表', `key 有效，共 ${knownIds.length} 个模型` + (fixes.length ? `，已自动纠正：${fixes.join('、')}` : ''));
  } catch (e) {
    const m = /HTTP (\d+)/.exec(e.message);
    const fix = m && m[1] === '401'
      ? 'Key 不对或没生效：确认复制全了、末尾没带空格。有些平台不充值就直接 401。'
      : m && (m[1] === '403')
        ? 'Key 无权限或账户被限：去控制台看余额/权限，或换个 Key。'
        : '这家可能不开放 /models，不影响批改——只要上面主模型名对就行。';
    push(false, '② 模型列表', `${e.message}${m ? '：' + httpErrorHint(Number(m[1])) : ''}`, fix);
  }

  // 3. 主模型对话（真实 completion；400 时解析"可用型号"自动换用重试一次）
  let chatOk = false;
  if (!model) { push(false, '③ 主模型对话', '没填模型名', '点高级设置里的「拉取模型列表」，从下拉里选一个'); }
  else {
    push(null, '③ 主模型对话', `向 ${model} 发送测试消息…`);
    const t0 = Date.now();
    try {
      const out = await callChat({ baseURL: base, model, apiKey: key }, chatTestMessages(), { temperature: 0 });
      push(true, '③ 主模型对话', `${model} 回复"${out.trim().slice(0, 20)}" · ${Date.now() - t0}ms`);
      chatOk = true;
    } catch (e) {
      const fixed = await tryFixFrom400(e, base, key, 'set-model', knownIds);
      if (fixed) {
        model = fixed;
        try {
          const out = await callChat({ baseURL: base, model, apiKey: key }, chatTestMessages(), { temperature: 0 });
          push(true, '③ 主模型对话', `已自动换用 ${model}，回复"${out.trim().slice(0, 20)}" · ${Date.now() - t0}ms`);
          chatOk = true;
        } catch (e2) { push(false, '③ 主模型对话', `换用 ${model} 后仍失败：${shortErr(e2.message)}`, '这个模型不可用：点高级设置里的「拉取模型列表」从下拉里挑一个。'); }
      } else {
        push(false, '③ 主模型对话', shortErr(e.message), modelFixHint(e, model));
      }
    }
  }

  // 4. 视觉模型真图测试（32px 纯色图，验证多模态与拍照转写链路）
  const vm = vmodel || model;
  if (!vm) { push(false, '④ 视觉模型', '没填视觉模型', '拍照转写要一个认图的型号：glm-4v-flash / qwen-vl-plus / deepseek-flash / gpt-4o-mini'); }
  else {
    push(null, '④ 视觉模型', `向 ${vm} 发一张测试图…`);
    const t0 = Date.now();
    try {
      const out = await callChat({ baseURL: base, model: vm, apiKey: key }, visionTestMessages(testImage()), { temperature: 0 });
      push(true, '④ 视觉模型', `${vm} 认出"${out.trim().slice(0, 20)}"（红色）· ${Date.now() - t0}ms —— 拍照转写链路可用`);
    } catch (e) {
      const fixed = await tryFixFrom400(e, base, key, 'set-vmodel', knownIds);
      if (fixed) {
        try {
          const out = await callChat({ baseURL: base, model: fixed, apiKey: key }, visionTestMessages(testImage()), { temperature: 0 });
          push(true, '④ 视觉模型', `已自动换用 ${fixed}，认出"${out.trim().slice(0, 20)}"（红色）· ${Date.now() - t0}ms —— 拍照转写链路可用`);
        } catch (e2) { push(false, '④ 视觉模型', `换用 ${fixed} 后仍失败：${shortErr(e2.message)}`, '换个认图的型号，或留空让它用主模型（但主模型多半不认图，拍照会失败）'); }
      } else {
        const m = /HTTP (\d+)/.exec(e.message);
        push(false, '④ 视觉模型', shortErr(e.message) + (m && m[1] === '400' ? '（这个型号不认图）' : ''),
          '换成多模态型号：glm-4v-flash / qwen-vl-plus / deepseek-flash / gpt-4o-mini；点「拉取模型列表」挑带 vision 的。');
      }
    }
  }
  finish(chatOk);
  return chatOk;

  function finish(ok) {
    btn.disabled = false; btn.textContent = '试一下';
    if (!ok) box.insertAdjacentHTML('beforeend', `<div class="diag-line bad"><span class="d-ico">!</span><span class="d-body"><span class="d-name">下一步</span><span class="d-detail">按上面每条的"怎么办"改，改完再点一次「试一下」。</span></span></div>`);
  }
}

// 主模型不通时给什么建议
function modelFixHint(err, model) {
  const m = /HTTP (\d+)/.exec(String(err.message));
  const code = m ? Number(m[1]) : 0;
  if (code === 401) return 'Key 不对或没生效：确认复制全了、没带空格。有些平台不充值直接 401。';
  if (code === 402 || code === 403) return '账户没余额或没权限：去控制台充值/开通该模型权限。';
  if (code === 429) return '被限流了：等一会儿再试，或换一家。';
  if (code === 404) return `地址或型号不对：确认 Base URL 和模型名「${model}」；点「拉取模型列表」从下拉里选。`;
  if (/超时/.test(String(err.message))) return '模型太慢或网络抖：换一个更快的型号，或重试一次。';
  return '点高级设置里的「拉取模型列表」，从下拉里挑一个你账号真正可用的型号。';
}
function diagLine(ok, name, detail, fix) {
  const icon = ok === null ? '…' : ok ? '✓' : '✗';
  const cls = ok === null ? 'doing' : ok ? 'ok' : 'bad';
  return `<div class="diag-line ${cls}"><span class="d-ico">${icon}</span><span class="d-body">`
    + `<span class="d-name">${esc(name)}</span>`
    + `<span class="d-detail">${esc(detail)}</span>`
    + (fix ? `<span class="d-fix"><b>怎么办：</b>${esc(fix)}</span>` : '')
    + `</span></div>`;
}
function shortErr(msg) {
  // 400 报错里服务商常附"可用型号清单"，解析成人话
  const m = /supported API model names are ([^".]+)/i.exec(String(msg));
  if (m) return `模型名不存在，该账号可用：${m[1].split(/[,，]\s*/).slice(0, 4).join('、')}`;
  const h = /HTTP (\d+)/.exec(String(msg));
  return String(msg).slice(0, 90) + (h ? '：' + (httpErrorHint(Number(h[1])) || '') : '');
}
// 400 且报错带可用型号清单时：挑最接近的自动换上（写回输入框）并返回新名字
async function tryFixFrom400(err, base, key, fieldId, knownIds) {
  const m = /supported API model names are ([^".]+)/i.exec(String(err.message));
  if (!m) return null;
  let cands = m[1].split(/[,，]\s*/).map((s) => s.trim()).filter(Boolean);
  if (knownIds) cands = cands.filter((c) => knownIds.includes(c)).length ? cands.filter((c) => knownIds.includes(c)) : cands;
  const cur = $(fieldId).value.trim().toLowerCase();
  const head = cur.split('-').slice(0, 2).join('-');
  const pick = cands.find((c) => c.toLowerCase().includes(head) && head) || cands[0];
  if (!pick || pick === $(fieldId).value.trim()) return null;
  $(fieldId).value = pick;
  return pick;
}
function testImage() {
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d9453a'; ctx.fillRect(0, 0, 32, 32);
  return c.toDataURL('image/png');
}

/* 拉取供应商的可用模型列表（GET {baseURL}/models，OpenAI 兼容标准接口） */
async function fetchModels() {
  const base = $('set-base').value.trim().replace(/\/+$/, '');
  if (!base) { $('models-result').textContent = '先选预设或填 Base URL。'; return; }
  const key = $('set-key').value.trim();
  const btn = $('btn-fetch-models');
  btn.disabled = true; btn.textContent = '拉取中…';
  $('models-result').textContent = '';
  try {
    const ids = await fetchModelList({ baseURL: base, apiKey: key });
    const fixes = syncModelLists(ids);
    $('models-result').textContent = `✓ 拉到 ${ids.length} 个模型，点型号输入框即可下拉选择`
      + (fixes.length ? `；已自动纠正：${fixes.join('、')}` : '（仍可手填）');
  } catch (e) {
    $('models-result').textContent = '✗ 拉取失败：' + e.message + '（个别服务商不开放 /models 或拦跨域，手动填型号即可）';
  } finally {
    btn.disabled = false; btn.textContent = '拉取模型列表';
  }
}

/* ---------- 历史抽屉（IndexedDB：完整报告 JSON 大，localStorage 5MB 会写爆） ---------- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('duograder', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('history', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function histAll() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const rq = db.transaction('history').objectStore('history').getAll();
    rq.onsuccess = () => res((rq.result || []).sort((a, b) => b.id - a.id));
    rq.onerror = () => rej(rq.error);
  });
}
async function histPut(entry) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('history', 'readwrite');
    tx.objectStore('history').put(entry);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function histDel(id) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('history', 'readwrite');
    tx.objectStore('history').delete(Number(id));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
// 旧版 localStorage 数据一次性迁移
async function histMigrate() {
  const raw = localStorage.getItem('duograder_history_v1');
  if (!raw) return;
  try {
    for (const it of JSON.parse(raw).slice(0, 50)) await histPut(it);
    localStorage.removeItem('duograder_history_v1');
  } catch { /* 损坏数据直接放弃迁移 */ }
}
function openDrawer() { renderHistory(); $('drawer').classList.add('show'); $('drawer-mask').classList.add('show'); }
function closeDrawer() { $('drawer').classList.remove('show'); $('drawer-mask').classList.remove('show'); }
async function renderHistory() {
  const h = await histAll();
  $('hist-list').innerHTML = h.length ? h.map((it) => `
    <div class="hist-item" data-id="${it.id}">
      <span class="hi-del" data-del="${it.id}">删除</span>
      <div class="hi-score">${it.final.final_score}<small style="font-size:12px;color:var(--muted)"> / ${it.final.final_range ? '档位' + it.final.final_band : ''}</small></div>
      <div class="hi-meta">${esc(it.ts)} · ${TRACKS[it.track]}${TASKS[it.task]} · ${it.final.final_band}档 ${it.final.final_score}分 · 初评 ${esc(String(it.final.initial?.[0]?.score ?? '?'))}/${esc(String(it.final.initial?.[1]?.score ?? '?'))}</div>
      <div class="hi-acts"><span class="hi-act" data-orig="${it.id}">原文</span><span class="hi-act" data-rep="${it.id}">报告</span></div>
    </div>`).join('') : '<div class="hint" style="padding:20px;text-align:center;">还没有批改记录</div>';
  $('hist-list').querySelectorAll('.hi-act').forEach((el) => el.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (el.dataset.orig) await showOriginal(el.dataset.orig);
    else await openHistoryReport(el.dataset.rep);
  }));
  $('hist-list').querySelectorAll('.hist-item').forEach((el) => el.addEventListener('click', async (ev) => {
    if (ev.target.dataset.del) {
      await histDel(ev.target.dataset.del);
      renderHistory();
      return;
    }
    await openHistoryReport(el.dataset.id);
  }));
}
// 历史项 → 只看终裁报告的干净视图（隐藏录入界面，可返回）
async function openHistoryReport(id) {
  const it = (await histAll()).find((x) => String(x.id) === String(id));
  if (!it) return;
  closeDrawer();
  document.body.classList.add('reviewing');
  renderReport(it.final, it.facts, it.essay);
  const back = document.createElement('button');
  back.className = 'icon-btn review-back';
  back.textContent = '← 返回';
  back.addEventListener('click', () => {
    document.body.classList.remove('reviewing');
    back.remove();
    $('report-area').innerHTML = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('report-area').prepend(back);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
// 原文弹窗：题面 + 作文
async function showOriginal(id) {
  const it = (await histAll()).find((x) => String(x.id) === String(id));
  if (!it) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask show';
  const card = document.createElement('div');
  card.className = 'modal-card';
  card.innerHTML = `
    <h3>原文回看 <span data-close>✕</span></h3>
    <div class="field"><label>题面</label><div class="essay-box">${esc(it.prompt || '该记录未保存题面')}</div></div>
    <div class="field" style="margin-bottom:0"><label>作文</label><div class="essay-box">${esc(it.essay || '')}</div></div>`;
  const close = () => { mask.remove(); card.remove(); };
  card.querySelector('[data-close]').addEventListener('click', close);
  mask.addEventListener('click', close);
  document.body.append(mask, card);
}
async function saveHistory(entry) {
  await histPut(entry);
}

/* ---------- 拍照上传与转写 ---------- */
async function compressImage(file, maxDim = 1568, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/* 文件导入：图片/PDF → 视觉转写管线；docx/txt/md → 抽文本自动路由题面/作文框 */
async function handleFiles(fileList, inputEl) {
  const files = [...fileList];
  if (inputEl) inputEl.value = ''; // 允许重复选同一个文件
  if (!files.length) return;
  const btn = $('btn-transcribe-all');
  btn.disabled = true;
  const notes = [];
  let addedPhotos = 0;
  try {
    for (const f of files) {
      const n = f.name || '文件';
      if (f.type.startsWith('image/')) {
        btn.textContent = `导入图片：${n.slice(0, 16)}…`;
        state.photos.push(await toImageDataUrl(f));
        addedPhotos++;
        continue;
      }
      if (f.type === 'application/pdf' || /\.pdf$/i.test(n)) {
        btn.textContent = `渲染 PDF：${n.slice(0, 16)}…`;
        const imgs = await pdfToImages(f);
        state.photos.push(...imgs);
        addedPhotos += imgs.length;
        notes.push(`${n} → ${imgs.length} 页图片`);
        continue;
      }
      if (/\.docx$/i.test(n) || f.type.includes('wordprocessingml')) {
        btn.textContent = `解析 Word：${n.slice(0, 16)}…`;
        importText(await docxToText(f), n);
        continue;
      }
      if (/\.doc$/i.test(n)) { notes.push(`${n}：旧版 .doc 不支持，请另存为 .docx`); continue; }
      if (f.type.startsWith('text/') || /\.(txt|md)$/i.test(n)) {
        importText(await f.text(), n);
        continue;
      }
      notes.push(`${n}：不支持的格式`);
    }
    renderThumbs();
    const parts = [];
    if (addedPhotos) parts.push(`图片/页面 ${addedPhotos} 张`);
    if (notes.length) parts.push(notes.join('；'));
    banner(parts.length ? '已导入：' + parts.join('。') : '没有可导入的文件。', addedPhotos || notes.some(x => !x.includes('不支持')) ? 'info' : 'bad');
  } catch (e) {
    banner('导入失败：' + e.message, 'bad');
  } finally {
    syncTranscribeBtn();
  }
}

// 动态加载解析库（拖入 PDF/Word 时才下载）
function ensureScript(src, check) {
  if (check()) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => check() ? res() : rej(new Error('解析库加载异常'));
    s.onerror = () => rej(new Error('解析库加载失败（检查网络）'));
    document.head.appendChild(s);
  });
}
async function pdfToImages(file, maxPages = 8) {
  await ensureScript(
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    () => window.pdfjsLib
  );
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = Math.min(pdf.numPages, maxPages);
  const out = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(canvas.toDataURL('image/jpeg', 0.85));
  }
  return out;
}
async function docxToText(file) {
  await ensureScript('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js', () => window.mammoth);
  const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  const text = (result.value || '').trim();
  if (!text) throw new Error('Word 文档里没有提取到文本（可能是纯图片，请改用截图/照片导入）');
  return text;
}
// 抽出的文本去哪个框：有任务指令词 → 题面框；否则 → 作文框（追加不覆盖）
// 注意不能用 chart/picture 判定——作文正文本来就常提这些词
function importText(text, name) {
  if (!text || !text.trim()) return;
  const looksLikePrompt = /directions|write (an|him|your) (essay|email|letter|reply)|answer sheet|\(\d+ points\)|suppose you|li ming/i.test(text.slice(0, 600));
  const id = looksLikePrompt ? 'prompt-in' : 'essay-in';
  const el = $(id);
  el.value = (el.value ? el.value.replace(/\s+$/, '') + '\n\n' : '') + text.trim();
  updateCountBar();
  if (id === 'prompt-in') applyDetection(true);
  banner(`已导入 ${name} → ${looksLikePrompt ? '题面' : '作文'}框（自动判断，可挪动）`, 'info');
}

async function toImageDataUrl(file) {
  try {
    return await compressImage(file);
  } catch {
    return await new Promise((res, rej) => { // 压缩失败兜底：直接读原图
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('无法读取图片'));
      r.readAsDataURL(file);
    });
  }
}

function syncTranscribeBtn() {
  const btn = $('btn-transcribe-all');
  if (state.busy) return; // 转写进行中：按钮由 transcribe() 控制（spinner + 点此取消）
  const n = state.photos.length;
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? '转写并分离' : `转写并分离（${n} 张照片）`;
}

function renderThumbs() {
  const box = $('thumbs-all');
  box.innerHTML = state.photos.map((d, i) => `
    <div class="thumb"><img src="${d}" alt="photo-${i + 1}" data-crop="${i}"/><span class="t-del" data-i="${i}">✕</span></div>`).join('');
  box.querySelectorAll('img[data-crop]').forEach((el) => el.addEventListener('click', () => openCrop(Number(el.dataset.crop))));
  box.querySelectorAll('.t-del').forEach((el) => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    state.photos.splice(Number(el.dataset.i), 1);
    renderThumbs();
  }));
  syncTranscribeBtn();
}

/* ---------- 照片裁剪：点缩略图进入；拖拽选区/四角缩放/90°旋转，输出保持原图分辨率 ---------- */
const crop = { idx: -1, img: null, rot: 0, scale: 1, rect: null, drag: null, rotCanvas: null };

function openCrop(i) {
  if (state.busy) return;
  crop.idx = i; crop.rot = 0; crop.drag = null; crop.img = null;
  const img = new Image();
  img.onload = () => {
    crop.img = img;
    $('modal-crop').classList.add('show');
    $('crop-mask').classList.add('show');
    cropFit();
  };
  img.src = state.photos[i];
}
function closeCrop() {
  $('modal-crop').classList.remove('show');
  $('crop-mask').classList.remove('show');
  crop.img = null; crop.drag = null;
}
// 原图旋转 90°*n 后画到离屏 canvas（保持全分辨率，裁剪从它取像素）
function cropRotated() {
  const { img, rot } = crop;
  const swap = rot % 180 !== 0;
  const w = swap ? img.naturalHeight : img.naturalWidth;
  const h = swap ? img.naturalWidth : img.naturalHeight;
  const c = crop.rotCanvas || (crop.rotCanvas = document.createElement('canvas'));
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return c;
}
function cropFit() {
  const rc = cropRotated();
  const canvas = $('crop-canvas');
  // 可用宽 = 父容器内容宽（去掉 padding），max-width 已从 CSS 移除，保证显示尺寸 = 计算尺寸
  const ps = getComputedStyle(canvas.parentElement);
  const innerW = canvas.parentElement.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight);
  const maxW = Math.min(innerW, 680);
  const maxH = Math.round(window.innerHeight * 0.56);
  crop.scale = Math.min(maxW / rc.width, maxH / rc.height);
  const dpr = window.devicePixelRatio || 1;
  const dispW = rc.width * crop.scale, dispH = rc.height * crop.scale;
  canvas.width = Math.round(dispW * dpr);
  canvas.height = Math.round(dispH * dpr);
  canvas.style.width = Math.round(dispW) + 'px';
  canvas.style.height = Math.round(dispH) + 'px';
  crop.rect = { x: dispW * 0.06, y: dispH * 0.06, w: dispW * 0.88, h: dispH * 0.88 };
  cropDraw();
}
function cropHandles() {
  const r = crop.rect;
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
}
function cropDraw() {
  const canvas = $('crop-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rc = cropRotated(), s = crop.scale, r = crop.rect;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(rc, 0, 0, rc.width * s, rc.height * s);
  // 选区外压暗
  ctx.fillStyle = 'rgba(17,17,17,0.58)';
  ctx.fillRect(0, 0, W, r.y);
  ctx.fillRect(0, r.y + r.h, W, H - r.y - r.h);
  ctx.fillRect(0, r.y, r.x, r.h);
  ctx.fillRect(r.x + r.w, r.y, W - r.x - r.w, r.h);
  // 边框 + 三分参考线
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  for (let k = 1; k <= 2; k++) {
    ctx.beginPath(); ctx.moveTo(r.x + (r.w * k) / 3, r.y); ctx.lineTo(r.x + (r.w * k) / 3, r.y + r.h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r.x, r.y + (r.h * k) / 3); ctx.lineTo(r.x + r.w, r.y + (r.h * k) / 3); ctx.stroke();
  }
  // 四角柄
  for (const [hx, hy] of cropHandles()) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(hx - 8, hy - 8, 16, 16);
    ctx.strokeStyle = '#111';
    ctx.strokeRect(hx - 7.5, hy - 7.5, 15, 15);
  }
}
function cropPos(e) {
  const b = $('crop-canvas').getBoundingClientRect();
  return { x: Math.min(Math.max(e.clientX - b.left, 0), b.width), y: Math.min(Math.max(e.clientY - b.top, 0), b.height) };
}
function cropHit(p) {
  const r = crop.rect, T = 34; // 触控热区 ≥34px
  const hs = cropHandles();
  for (let k = 0; k < 4; k++) {
    if (Math.abs(p.x - hs[k][0]) <= T && Math.abs(p.y - hs[k][1]) <= T) return { mode: 'resize', corner: k };
  }
  if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) return { mode: 'move' };
  return { mode: 'new' };
}
function cropNorm(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
function cropClamp(r) {
  const W = $('crop-canvas').width / (window.devicePixelRatio || 1);
  const H = $('crop-canvas').height / (window.devicePixelRatio || 1);
  const MIN = 60;
  r.w = Math.max(Math.min(r.w, W), MIN);
  r.h = Math.max(Math.min(r.h, H), MIN);
  r.x = Math.min(Math.max(r.x, 0), W - r.w);
  r.y = Math.min(Math.max(r.y, 0), H - r.h);
  return r;
}
function bindCrop() {
  const canvas = $('crop-canvas');
  canvas.addEventListener('pointerdown', (e) => {
    if (!crop.img) return;
    const p = cropPos(e);
    const hit = cropHit(p);
    crop.drag = { hit, start: p, orig: { ...crop.rect } };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!crop.drag) return;
    const p = cropPos(e);
    const { hit, start, orig } = crop.drag;
    if (hit.mode === 'move') {
      crop.rect = cropClamp({ x: orig.x + p.x - start.x, y: orig.y + p.y - start.y, w: orig.w, h: orig.h });
    } else if (hit.mode === 'resize') {
      // 锚点=对角，拖动角在锚点与指针之间取矩形
      const anchors = [[orig.x + orig.w, orig.y + orig.h], [orig.x, orig.y + orig.h], [orig.x + orig.w, orig.y], [orig.x, orig.y]];
      const [ax, ay] = anchors[hit.corner];
      crop.rect = cropClamp(cropNorm({ x: ax, y: ay }, p));
    } else {
      crop.rect = cropClamp(cropNorm(start, p));
    }
    cropDraw();
  });
  const stop = (e) => { if (crop.drag) { canvas.releasePointerCapture?.(e.pointerId); crop.drag = null; } };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  $('btn-crop-rotate').addEventListener('click', () => { crop.rot = (crop.rot + 90) % 360; cropFit(); });
  $('btn-crop-reset').addEventListener('click', cropFit);
  $('btn-crop-ok').addEventListener('click', () => {
    const rc = cropRotated(), s = crop.scale, r = crop.rect;
    const sx = r.x / s, sy = r.y / s, sw = r.w / s, sh = r.h / s;
    const MAX = 2200; // 裁剪输出上限：够视觉识别，控请求体积
    const k = Math.min(1, MAX / Math.max(sw, sh));
    const out = document.createElement('canvas');
    out.width = Math.round(sw * k);
    out.height = Math.round(sh * k);
    out.getContext('2d').drawImage(rc, sx, sy, sw, sh, 0, 0, out.width, out.height);
    state.photos[crop.idx] = out.toDataURL('image/jpeg', 0.9);
    closeCrop();
    renderThumbs();
  });
  $('crop-close').addEventListener('click', closeCrop);
  $('crop-mask').addEventListener('click', closeCrop);
}

function visionSettings() {
  const s = state.settings || {};
  // preset 必须带出来：core.js 据此判断是否附加设备指纹（只有内置算力通道才发）
  return { preset: s.preset, baseURL: s.baseURL, apiKey: s.apiKey, model: s.vmodel || s.model };
}

async function transcribe() {
  // 转写中再点 = 取消（大模型慢，必须可中止）
  if (state.busy) {
    if (state.tAbort) state.tAbort.abort();
    return;
  }
  if (!state.photos.length) { banner('先添加照片，题面与作文一起拍即可。', 'bad'); return; }
  if (!state.settings?.baseURL || (!state.settings?.apiKey && state.settings?.preset !== 'invite')) { openSettings(); banner('请先在设置里配置 API（转写需要视觉模型）。', 'bad'); return; }
  // 覆盖确认：文本框已有内容且不是上次转写结果时先问一声
  if (['prompt-in', 'essay-in'].some((id) => $(id).value.trim() && $(id).value !== state.lastTranscribed?.[id])) {
    if (!confirm('转写会覆盖文本框里已有的内容，继续？')) return;
  }
  state.busy = true;
  state.tAbort = new AbortController();
  const btn = $('btn-transcribe-all');
  // 等待反馈：按钮加 spinner + 轮换提示（大模型读手写确实慢，让用户知道没卡死）
  const WAIT_LINES = [
    '正在识别照片文字…',
    '分离题面与手写作文…',
    '手写识别较慢，约需 0.5–2 分钟，请稍候…',
  ];
  let wi = 0;
  btn.innerHTML = '<span class="spin"></span><span id="wait-label">转写中…（点此取消）</span>';
  const waitNote = $('wait-note');
  waitNote.hidden = false;
  waitNote.textContent = WAIT_LINES[0];
  const waitTimer = setInterval(() => { wi = (wi + 1) % WAIT_LINES.length; waitNote.textContent = WAIT_LINES[wi]; }, 6000);
  try {
    state.lastTranscribed = state.lastTranscribed || {};
    const out = await callChat(visionSettings(), transcriptionMessages(state.photos, 'combined'), {
      temperature: 0, timeout: 180000, signal: state.tAbort.signal, retries: 1,
      bodyExtra: { reasoning_effort: 'low' }, // 转写是读图任务：低思考档，把深度推理留给批改
    });
    const parsed = parseModelJSON(out);
    if (!parsed.ok) throw new Error('模型输出解析失败：' + parsed.error);
    const { prompt = '', essay = '', task_guess: tg, track_guess: trg, evidence, crossed_out: crossed } = parsed.obj || {};
    if (!String(essay).trim()) throw new Error('没认出手写作文——照片里手写部分清楚吗？多拍一张近景再试。');
    $('prompt-in').value = String(prompt).trim();
    $('essay-in').value = String(essay).trim();
    state.lastTranscribed['prompt-in'] = String(prompt).trim();
    state.lastTranscribed['essay-in'] = String(essay).trim();
    updateCountBar();
    // 科目/题型：题面文字里的字数/分值是硬信号（160-200词/20分→英一等），
    // 优先于视觉模型的体裁猜测——混合题型（图画+图表，2022 英一）曾被体裁特征误判为英二。
    const textDetect = detectTaskType(String(prompt).trim());
    const visionOk = ['large', 'small'].includes(tg) && ['english-i', 'english-ii'].includes(trg);
    if (textDetect.track && (textDetect.evidence || []).some((e) => /词|words|points|分/i.test(e))) {
      applyDetectResult({ task: textDetect.task, track: textDetect.track, evidence: textDetect.evidence.join('；') });
      if (visionOk && trg !== textDetect.track) {
        const note = $('detect-note');
        note.hidden = false;
        note.textContent = `⚠️ 转写模型按体裁猜了${TRACKS[trg]}，但题面明示「${textDetect.evidence.join('；')}」——已按题面判定为${TRACKS[textDetect.track]}，请核对。`;
      }
    } else if (!applyDetectResult({ task: tg, track: trg, evidence })) {
      applyDetection(true);
    }
    // 划掉内容核对：模型跳过了什么，用户必须能看到
    const cn = $('crossed-note');
    if (Array.isArray(crossed) && crossed.length) {
      cn.hidden = false;
      cn.textContent = `已按划线删除忽略 ${crossed.length} 处：${crossed.map((c) => `「${String(c).slice(0, 30)}」`).join('、')}。如有误删，请直接补进作文框。`;
    } else {
      cn.hidden = true;
    }
    // 核对确认闸门：新转写生效，重置确认状态
    state.transcribed = true;
    state.confirmed = false;
    $('confirm-check').checked = false;
    $('confirm-row').hidden = false;
    updateGradeGate();
    banner(String(prompt).trim() ? '转写完成。请核对文本，勾选确认后开始双评。'
      : '转写完成，未识别到印刷题面（切题维度将按暂定处理）。请核对后勾选确认。', 'info');
    $('card-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    if (state.tAbort.signal.aborted) banner('转写已取消。', 'info');
    else banner('转写失败：' + e.message + (/404|model/i.test(String(e.message)) ? '（当前模型可能不支持图片输入，请在设置里填视觉模型）' : ''), 'bad');
  } finally {
    clearInterval(waitTimer);
    state.busy = false;
    state.tAbort = null;
    $('wait-note').hidden = true;
    syncTranscribeBtn();
  }
}

/* ---------- 流水线 ---------- */
function setStep(id, cls, note) {
  const el = $(id);
  el.className = 'step' + (cls ? ' ' + cls : '');
  if (note !== undefined) el.querySelector('.st-note').textContent = note;
}
function trackUsage(u) {
  state.runUsage = state.runUsage || { calls: 0, tokens: 0 };
  state.runUsage.calls++;
  state.runUsage.tokens += u.total_tokens || 0;
}
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

/* 核对确认闸门：走过拍照转写的，必须勾选确认才能批改；直接打字的不受影响 */
function updateGradeGate() {
  const btn = $('btn-grade');
  const gated = state.transcribed && !state.confirmed;
  btn.disabled = state.busy || gated;
  btn.textContent = gated
    ? '请先勾选确认转写内容'
    : state.busy ? btn.textContent : '开始双评';
}

async function gradeOnce(label) {
  const facts = state.facts;
  const messages = graderMessages({
    rubric: state.rubric, schema: state.schema, facts,
    prompt: $('prompt-in').value.trim(), essay: $('essay-in').value,
    kernel: state.kernel,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    // high 档：max 档批改 >100s 会被 Cloudflare 代理 524 掐断（直连场景才可用 max）
    const out = await callChat(state.settings, attempt === 0 ? messages : repairMessages(messages, state.lastBad?.[label], state.lastProblems?.[label]), { temperature: 0.3, signal: state.abort?.signal, onUsage: trackUsage, timeout: 150000, bodyExtra: { reasoning_effort: 'high' } });
    const parsed = parseModelJSON(out);
    if (parsed.ok) {
      const v = validateReport(parsed.obj, $('essay-in').value);
      if (!v.failures.length) return { report: parsed.obj, warnings: v.warnings, raw: out };
      state.lastProblems = state.lastProblems || {}; state.lastProblems[label] = v.failures;
    } else {
      state.lastProblems = state.lastProblems || {}; state.lastProblems[label] = [parsed.error];
    }
    state.lastBad = state.lastBad || {}; state.lastBad[label] = out;
  }
  throw new Error(`阅卷员 ${label} 两次输出均未通过机器校验：${(state.lastProblems?.[label] || []).join('；')}`);
}

async function runPipeline() {
  if (state.busy) return;
  state.busy = true; // 先置位防连点，下同
  const essay = $('essay-in').value;
  if (state.transcribed && !state.confirmed) { state.busy = false; banner('转写结果需先核对确认后再批改。', 'bad'); return; }
  if (!essay.trim()) { state.busy = false; banner('先粘贴或输入你的作文（或拍照转写）。', 'bad'); return; }
  if (!state.rubric) { state.busy = false; banner('评分规则未加载。', 'bad'); return; }
  if (!state.settings?.baseURL || (!state.settings?.apiKey && state.settings?.preset !== 'invite')) { state.busy = false; openSettings(); banner('请先在设置里配置 API。', 'bad'); return; }

  state.abort = new AbortController();
  state.runUsage = { calls: 0, tokens: 0 };
  $('btn-grade').disabled = true;
  $('btn-grade').textContent = '批改中…（点此取消）';
  $('btn-grade').classList.add('canceling');
  state.lastBad = {}; state.lastProblems = {};
  $('pipeline-card').hidden = false;
  $('report-area').innerHTML = '';
  window.scrollTo({ top: document.body.scrollHeight * 0.3, behavior: 'smooth' });

  try {
    // 1. 预检
    let t0 = Date.now();
    state.facts = precheck(essay, state.track, state.task);
    setStep('st-pre', 'done', `${state.facts.word_count} 词 · ${state.facts.paragraph_count} 段${state.facts.mechanical_flags.length ? ' · 机械问题 ' + state.facts.mechanical_flags.length + ' 处' : ''} · ${secs(Date.now() - t0)}`);

    // 2. 双盲（并发，互不可见）
    t0 = Date.now();
    setStep('st-a', 'doing', '评分中…'); setStep('st-b', 'doing', '评分中…');
    const pa = gradeOnce('A').then((r) => { setStep('st-a', 'done', `第${r.report.band.band}档 · ${r.report.scores.total} 分`); return r; })
      .catch((e) => { setStep('st-a', 'fail', e.message.slice(0, 60)); throw e; });
    const pb = gradeOnce('B').then((r) => { setStep('st-b', 'done', `第${r.report.band.band}档 · ${r.report.scores.total} 分`); return r; })
      .catch((e) => { setStep('st-b', 'fail', e.message.slice(0, 60)); throw e; });
    const [ra, rb] = await Promise.all([pa, pb]);

    // 3. 校验 & 合并/仲裁
    setStep('st-val', 'done', `两份报告均通过 · ${secs(Date.now() - t0)} · tokens ${state.runUsage.tokens}`);
    setStep('st-merge', 'doing');
    let final;
    const bandGap = Math.abs(ra.report.band.band - rb.report.band.band);
    if (bandGap >= 2) {
      setStep('st-merge', 'fail', `两位阅卷员档位差 ${bandGap} 档，判定失效`);
      $('report-area').innerHTML = `<div class="card"><h2><span class="dot"></span>本轮作废（needs_regrade）</h2>
        <p style="font-size:13.5px;color:var(--muted)">A 判第${ra.report.band.band}档 ${ra.report.scores.total} 分，B 判第${rb.report.band.band}档 ${rb.report.scores.total} 分——多半有一方读错题。请点"开始双评"重跑一轮。</p></div>`;
      return;
    }
    const m = mergeSameBand(ra.report, rb.report);
    if (m.ok) {
      final = m.final;
      setStep('st-merge', 'done', '同档，脚本确定性合并（均值）');
    } else if (m.reason === 'dimension_names') {
      // 同档但维度口径不一致 → 按 rubric 打回重评，绝不能送仲裁：
      // 仲裁协议是"差一档二选一"，用在同档上等于整份挑一份，丢掉确定性均值合并。
      // （旧实现把 reason 丢掉，所有失败一律标成"档位差 1"并送仲裁，结论与 Skill 路径不一致）
      setStep('st-merge', 'fail', '维度口径不一致，本轮作废');
      const d = m.detail || { only_a: [], only_b: [] };
      const diff = [...d.only_a.map((x) => 'A 有 ' + x), ...d.only_b.map((x) => 'B 有 ' + x)].join('、') || '维度集合不一致';
      $('report-area').innerHTML = `<div class="card"><h2><span class="dot"></span>本轮作废（维度口径不一致）</h2>
        <p style="font-size:13.5px;color:var(--muted)">A 与 B 的评分维度对不齐（${esc(diff)}），无法做确定性均值合并。请点"开始双评"重跑一轮。</p></div>`;
      return;
    } else {
      // arbiter（档位差 1）/ out_of_band（合并后越界，需第三方复核）→ 走仲裁
      setStep('st-merge', 'doing', `档位差 ${bandGap}，仲裁中…`);
      const out = await callChat(state.settings, arbiterMessages({
        rubric: state.rubric, essay, prompt: $('prompt-in').value.trim(), reportA: ra.report, reportB: rb.report,
        kernel: state.kernel,
      }), { temperature: 0.2, signal: state.abort?.signal, onUsage: trackUsage, timeout: 150000, bodyExtra: { reasoning_effort: 'high' } });
      const parsed = parseModelJSON(out);
      if (!parsed.ok) throw new Error('仲裁输出解析失败：' + parsed.error);
      final = parsed.obj;
      final.report_a = ra.report; final.report_b = rb.report;
      setStep('st-merge', 'done', `仲裁：${final.decision === 'pick_a' ? '采 A' : final.decision === 'pick_b' ? '采 B' : final.decision}`);
    }

    renderReport(final, state.facts, essay);
    saveHistory({
      id: Date.now(), ts: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      track: state.track, task: state.task, essay, prompt: $('prompt-in').value.trim(), facts: state.facts, final,
      model: state.settings?.model || '',
    });
    renderHistory();
  } catch (e) {
    banner('批改失败：' + e.message, 'bad');
  } finally {
    state.busy = false;
    state.abort = null;
    $('btn-grade').disabled = false;
    $('btn-grade').textContent = '开始双评';
    $('btn-grade').classList.remove('canceling');
  }
}

/* ---------- 报告渲染 ---------- */
// 级别中英兼容显示（内核 v1.4 起为中文；旧历史记录是英文枚举）
const SEV_DISP = { '错误': '错误', '欠佳': '欠佳', '润色': '润色', error: '错误', awkward: '欠佳', style: '润色' };
const SEV_CLS = { '错误': 'error', '欠佳': 'awkward', '润色': 'style', error: 'error', awkward: 'awkward', style: 'style' };

// 入场阶梯：按当前 DOM 顺序写 --d，不用 CSS :nth-child（插入任何兄弟节点都会让索引错位）
function staggerCards(container, step = 60) {
  if (!container) return;
  [...container.children].forEach((el, i) => {
    if (el.classList.contains('card')) el.style.setProperty('--d', i * step + 'ms');
  });
}

// 双评汇聚尺的生成在 core.js（纯逻辑，可被单测覆盖）：见 dualRail()

function renderReport(final, facts, essay) {
  const track = final.report_a?.meta?.exam_track || state.track || 'english-ii';
  const task = final.report_a?.meta?.task || state.task || 'large';
  const maxScore = { 'english-i_large': 20, 'english-ii_large': 15, 'english-i_small': 10, 'english-ii_small': 10 }[`${track}_${task}`] || 15;
  const [ia, ib] = final.initial || [];
  const dims = final.dimensions || [];
  const edits = final.report_b?.sentence_edits || final.report_a?.sentence_edits || [];
  const rep = final.decision === 'pick_b' ? final.report_b : final.report_a;
  const flags = (facts?.mechanical_flags) || [];
  const modelLabel = final.report_a?.meta?.grader_model || state.settings?.model || '';

  $('report-area').innerHTML = `
  <section class="card">
    <h2><span class="dot"></span>终裁报告</h2>
    <div class="score-hero">
      <div class="score-big">${esc(final.final_score)}<small> / ${maxScore}</small></div>
      <div class="score-meta">
        <span>科目题型</span><b>${TRACKS[track]} · ${TASKS[task]}</b>
        <span>档位</span><b>第 ${esc(final.final_band)} 档（${esc(String(final.final_range || ''))}）</b>
        <span>字数</span><b>${esc(String(facts?.word_count ?? '?'))} 词（预检脚本）</b>
        ${modelLabel ? `<span>阅卷模型</span><b>${esc(modelLabel)}</b>` : ''}
      </div>
    </div>
    ${dualRail(final, maxScore, ia, ib)}
    ${flags.length ? flags.map((f) => `<div class="flag-line">预检 · ${esc(f.detail)}（${f.count} 处）</div>`).join('') : ''}
    <table class="rep"><thead><tr><th style="width:32%">维度</th><th>分值</th><th>得分</th><th style="width:44%">扣分依据</th></tr></thead>
      <tbody>${dims.map((d) => `<tr><td>${esc(d.name)}</td><td class="num">${esc(String(d.max))}</td><td class="num" style="color:var(--accent-deep)">${esc(String(d.score))}</td><td>${esc(d.note || d.deduction_reason || '')}</td></tr>`).join('')}</tbody></table>
  </section>

  <section class="card">
    <h2><span class="dot"></span>逐句批改（${edits.length} 处）</h2>
    <table class="rep"><thead><tr><th style="width:42%">原句</th><th>级别</th><th style="width:42%">修改与说明</th></tr></thead>
      <tbody>${edits.map((e) => `<tr>
        <td class="en">${esc(e.original)}</td>
        <td><span class="chip ${esc(SEV_CLS[e.severity] || 'style')}">${esc(SEV_DISP[e.severity] || e.severity)}</span></td>
        <td>${esc(e.revised)}<div style="font-size:12px;color:var(--muted);margin-top:3px">${esc(e.issue)}</div></td>
      </tr>`).join('') || '<tr><td colspan="3">未发现需要修改的句子</td></tr>'}</tbody></table>
    <div class="hint" style="margin-top:8px">级别说明：<b>错误</b>＝硬伤，考试会扣分 · <b>欠佳</b>＝不算错但不地道，不直接扣分 · <b>润色</b>＝原句无错，仅供参考</div>
  </section>

  <section class="card">
    <h2><span class="dot"></span>修改后版本（保留你的立意）</h2>
    <div class="essay-box">${esc(rep?.improved_version || '—')}</div>
    ${(rep?.top_problems || []).length ? `<h2 style="margin-top:20px"><span class="dot"></span>最限制得分的问题</h2>
    <ul class="problems">${rep.top_problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${rep?.practice_advice ? `<div class="advice">🎯 ${esc(rep.practice_advice)}</div>` : ''}
    ${(rep?.reusable?.patterns || rep?.reusable?.words) ? `<h2 style="margin-top:20px"><span class="dot"></span>可复用</h2>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
        ${(rep.reusable.patterns || []).map((p) => `<span class="chip style">${esc(p)}</span>`).join('')}
        ${(rep.reusable.words || []).map((w) => `<span class="chip awkward">${esc(w)}</span>`).join('')}
      </div>` : ''}
  </section>`;
  staggerCards($('report-area'), 70);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

init().catch((e) => {
  // 初始化失败必须让用户看见：一个不会响应任何按钮的页面，比报错难查一百倍
  console.error('DuoGrader init failed', e);
  try {
    $('banner-area').innerHTML = `<div class="banner">页面初始化失败：${esc(String(e?.message || e))}<br/>请刷新页面；若反复出现，去仓库 Issues 反馈。</div>`;
  } catch {}
});
// 免费额度角标：页面载入即向 /v1/quota 查询本 IP 剩余次数（邀请码登录态则不显示）
refreshFreeQuota();
// e2e 调试钩子：只读暴露内部状态（不参与业务逻辑）
window.__dg = { state, crop };
