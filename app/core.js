// DuoGrader 核心逻辑（纯函数，与 skill/scripts/*.py 保持同口径）
// 浏览器与 Node 均可加载（ESM）。

export const RECOMMENDED = {
  'english-i_small': [100, 100],
  'english-i_large': [160, 200],
  'english-ii_small': [100, 100],
  'english-ii_large': [150, 150],
};

export const BAND_TABLE = {
  10: { 5: [9, 10], 4: [7, 8], 3: [5, 6], 2: [3, 4], 1: [1, 2], 0: [0, 0] },
  20: { 5: [17, 20], 4: [13, 16], 3: [9, 12], 2: [5, 8], 1: [1, 4], 0: [0, 0] },
  15: { 5: [13, 15], 4: [10, 12], 3: [7, 9], 2: [4, 6], 1: [1, 3], 0: [0, 0] },
};

export const MAX_SCORES = { 'english-i_large': 20, 'english-ii_large': 15, 'english-i_small': 10, 'english-ii_small': 10 };

const WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+(?:[.,]\d+)*%?/g;
const CHINESE_RE = /[\u4e00-\u9fff]/g;

export function countWords(text) {
  return (text.match(WORD_RE) || []).length;
}

export function splitParagraphs(text) {
  const blocks = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (blocks.length === 1 && blocks[0].includes('\n')) {
    return { paras: blocks[0].split('\n').map((l) => l.trim()).filter(Boolean), basis: 'single_newline' };
  }
  return { paras: blocks, basis: 'blank_line' };
}

export function lengthStatus(count, lo, hi) {
  const ratio = lo ? count / lo : 1;
  let status;
  if (ratio >= 1.0) status = 'ok';
  else if (ratio >= 0.8) status = 'soft_ok';
  else if (ratio >= 2 / 3) status = 'soft_short';
  else if (ratio >= 0.5) status = 'short_two_thirds';
  else status = 'short_half';
  return { ratio, status, overlong: hi && hi !== lo && count > hi * 1.5 };
}

export function mechanicalFlags(text) {
  const flags = [];
  const zh = (text.match(CHINESE_RE) || []).length;
  if (zh) flags.push({ type: 'chinese_chars', count: zh, detail: '作文正文含中文字符（疑似混入）' });
  const repeated = text.match(/\b([A-Za-z]+)\s+\1\b/gi) || [];
  if (repeated.length) {
    // 去重后必须排序：precheck.py 用 sorted()，这里不排会让两套实现的事实清单文案不一致
    const uniq = [...new Set(repeated.map((r) => r.trim().split(/\s+/)[0].toLowerCase()))].sort().slice(0, 8);
    flags.push({ type: 'repeated_word', count: repeated.length, detail: '疑似相邻重复词: ' + uniq.join(', ') });
  }
  const miss = (text.match(/[A-Za-z][,.;:!?][A-Za-z]/g) || []).length;
  if (miss) flags.push({ type: 'missing_space_after_punct', count: miss, detail: '标点后疑似缺空格（如 word,Next）' });
  const dp = (text.replace(/\.\.\./g, '').match(/[,;:!?]{2,}/g) || []).length;
  if (dp) flags.push({ type: 'double_punct', count: dp, detail: '连续标点（省略号除外）' });
  const sentences = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  // 计数要用全量（与 precheck.py 同口径）；只取前 3 条是给 detail 展示用的
  const lowerAll = sentences.filter((s) => /^[a-z]/.test(s.trim()));
  if (lowerAll.length) {
    const lower = lowerAll.slice(0, 3);
    flags.push({ type: 'lowercase_sentence_start', count: lowerAll.length, detail: '句首小写: ' + lower.map((s) => s.trim().slice(0, 30)).join(' | ') });
  }
  return flags;
}

export function precheck(text, track, task) {
  const words = countWords(text);
  const { paras, basis } = splitParagraphs(text);
  const sentences = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const [lo, hi] = RECOMMENDED[`${track}_${task}`];
  const len = lengthStatus(words, lo, hi);
  const out = {
    track, task,
    word_count: words,
    recommended_words: [lo, hi],
    ratio_to_minimum: Math.round(len.ratio * 1000) / 1000,
    length_status: len.status,
    overlong: len.overlong,
    paragraph_count: paras.length,
    paragraph_basis: basis,
    paragraph_word_counts: paras.map(countWords),
    sentence_count: sentences.length,
    avg_sentence_words: sentences.length ? Math.round((words / sentences.length) * 10) / 10 : 0,
    mechanical_flags: mechanicalFlags(text),
  };
  if (task === 'small') {
    out.small_writing_format = {
      salutation: /^\s*dear\s+/im.test(text),
      closing: /yours\s+(sincerely|faithfully|truly)/im.test(text) || /^\s*best\s+wishes/im.test(text),
      signature_li_ming: /^\s*li\s+ming\s*\.?\s*$/im.test(text),
    };
  }
  return out;
}

export function snapHalfDown(x) {
  return Math.floor(x * 2 + 0.499999) / 2;
}

// —— 题型/科目自动识别（依据题面里的词数、分值、体裁关键词） ——
export function detectTaskType(promptText) {
  const t = String(promptText || '');
  const res = { task: null, track: null, evidence: [] };
  const hasSmall = /about\s*100\s*words|10\s*points/i.test(t);
  const hasE1Large = /160\s*[-–—~至到]\s*200\s*words|20\s*points/i.test(t);
  const hasE2Large = /about\s*150\s*words|15\s*points/i.test(t);
  if (hasE1Large) {
    res.task = 'large'; res.track = 'english-i';
    res.evidence.push('160-200 词 / 20 分 → 英语一大作文');
  } else if (hasE2Large && !hasSmall) {
    res.task = 'large'; res.track = 'english-ii';
    res.evidence.push('约 150 词 / 15 分 → 英语二大作文');
  } else if (hasSmall && !hasE2Large && !hasE1Large) {
    res.task = 'small';
    res.evidence.push('约 100 词 / 10 分 → 小作文');
  } else if (hasSmall && (hasE2Large || hasE1Large)) {
    // 一页同时含 Part A 和 Part B 信息：默认按大作文，请人工确认
    res.task = 'large'; res.track = hasE1Large ? 'english-i' : 'english-ii';
    res.evidence.push('题面同时含小/大作文信息，暂按大作文——若写的是小作文请点改');
  }
  if (!res.task) {
    if (/\bchart\b|\btable\b|\bgraph\b|\bstatistics\b|图表/i.test(t)) {
      res.task = 'large'; res.track = 'english-ii';
      res.evidence.push('图表体裁 → 英语二大作文');
    } else if (/\bpicture\b|\bdrawing\b|\bcartoon\b|\bphotos?\b|图画|漫画/i.test(t)) {
      res.task = 'large'; res.track = 'english-i';
      res.evidence.push('图画体裁 → 英语一大作文');
    } else if (/\bemail\b|\bletter\b|\bnotice\b|\breply\b|书信|邮件|通知/i.test(t)) {
      res.task = 'small';
      res.evidence.push('书信/通知体裁 → 小作文');
    }
  }
  return res;
}

// —— 模型输出解析（容错：围栏、首尾杂质、数组对象间漏逗号、JSON 后跟注释文字） ——
export function parseModelJSON(text) {
  let raw = String(text).trim();
  raw = raw.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
  const tries = [];
  if (first >= 0 && last > first) tries.push(raw.slice(first, last + 1));
  tries.push(raw);
  let err;
  for (const c of tries) {
    try { return { ok: true, obj: JSON.parse(c) }; }
    catch (e) {
      err = e;
      // "Unexpected non-whitespace character after JSON at position N"
      // → JSON 本体在 N 处已结束，后面是模型的注释文字，直接截断重试
      const m = /after JSON at position (\d+)/.exec(e.message || '');
      if (m) {
        try { return { ok: true, obj: JSON.parse(c.slice(0, Number(m[1]))) }; }
        catch (e2) { err = e2; }
      }
      const repaired = c.replace(/\}\s*\{\s*"/g, '},{"');
      if (repaired !== c) {
        try { return { ok: true, obj: JSON.parse(repaired) }; }
        catch (e2) { err = e2; }
      }
    }
  }
  return { ok: false, error: 'JSON 解析失败: ' + (err?.message || '未找到 JSON') };
}

const EPS = 0.01;
const negated = (s) => s.replace(/(并无|不是|没有|不算|不属于|不含|非)错误/g, '');
// 内核 v1.4：级别用中文，历史英文枚举保持兼容
const SEV_ALIAS = { '错误': 'error', '欠佳': 'awkward', '润色': 'style', error: 'error', awkward: 'awkward', style: 'style' };
// rubric 5.2 黑名单：可复用句式里出现即打回（与 scripts/validate_report.py 同口径）
const REUSABLE_BLACKLIST = ['warm and happy', 'every coin has two sides', 'with the development of', 'i will be very happy', 'as far as i am concerned'];

// —— 双评汇聚尺（报告头的签名元素，纯函数）——
// 把两位阅卷员的初评与终裁分放到同一条 0..满分 刻度上：
// 同档 → 两个刻点垂直对齐（均值合并）；差一档 → 刻点分开、终裁落在被采信的一方。
// 一眼看见这个产品在干什么，而不是读一行说明文字。
export function dualRail(final, maxScore, ia, ib) {
  const ratio = (v) => {
    const n = Number(v);
    // 定 4 位：既够精确，又不让内联样式里出现一长串浮点尾数（各分支格式必须一致）
    if (!Number.isFinite(n)) return '0.0000';
    return Math.max(0, Math.min(1, n / maxScore)).toFixed(4);
  };
  const num = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? '?' : String(v));
  const row = (label, score, kind, delay) => `
    <div class="dr-row ${kind}">
      <span class="dr-label">${label}</span>
      <span class="dr-track">
        <i class="dr-fill" style="--ratio:${ratio(score)};--d:${delay}ms"></i>
        <i class="dr-mark" style="--ratio:${ratio(score)};--d:${delay}ms"></i>
      </span>
      <span class="dr-num">${num(score)}</span>
    </div>`;
  const dec = final.decision;
  const mech = dec === 'same_band'
    ? '同档 · 脚本确定性合并（尾数从严）'
    : `差 ${num(final.band_gap ?? 1)} 档 · 第三方仲裁${dec === 'pick_a' ? '采 A' : dec === 'pick_b' ? '采 B' : ''}`;
  return `
  <div class="dual-rail">
    <div class="dr-head">
      <span class="dr-eyebrow">双评过程</span>
      <span class="dr-mech">${mech}</span>
    </div>
    ${row('阅卷员 A', ia?.score, '', 0)}
    ${row('阅卷员 B', ib?.score, '', 110)}
    ${row('终裁', final.final_score, 'dr-final', 220)}
  </div>`;
}

// —— 草稿：一次批改要跑 2-3 分钟，手机锁屏/切后台可能把页面重载 ——
// 作文与题面在重载后就没了，学生得重打一遍；这里做一份本地草稿兜底。
export const DRAFT_KEY = 'duograder_draft_v1';
export const LAST_GRADED_KEY = 'duograder_last_graded_v1';

export function buildDraft({ essay, prompt, track, task }) {
  return {
    essay: String(essay ?? ''),
    prompt: String(prompt ?? ''),
    track: track || '',
    task: task || '',
    ts: Date.now(),
  };
}

// 该不该恢复？两份都不空，且比上次批改成功更晚——批改成功的草稿已经被消费掉了
export function draftIsRestorable(draft, lastGradedAt) {
  if (!draft || typeof draft !== 'object') return false;
  if (!String(draft.essay ?? '').trim() && !String(draft.prompt ?? '').trim()) return false;
  return Number(draft.ts || 0) > Number(lastGradedAt || 0);
}

// —— 历史成绩分析 ——
// 不同科目题型的满分不同（英一大作文 20 / 英二大作文 15 / 小作文 10），
// 直接把原始分画在一条线上没法比，所以默认按"得分率"（得分 / 满分）画——
// 同一条线上才看得出是进步还是退步。
export function buildScoreCurve(history) {
  const rows = (history || []).map((it) => {
    const max = MAX_SCORES[`${it?.track}_${it?.task}`] || 0;
    const score = Number(it?.final?.final_score);
    const at = Number(it?.id) || 0;
    if (!max || !Number.isFinite(score) || !at) return null;
    return {
      id: it.id, at, track: it.track, task: it.task, max, score,
      rate: score / max,
      band: it?.final?.final_band ?? null,
      words: it?.facts?.word_count ?? null,
    };
  }).filter(Boolean).sort((a, b) => a.at - b.at);

  if (!rows.length) return { points: [], stats: null, groups: [] };

  const rates = rows.map((r) => r.rate);
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
  const best = rows.reduce((a, b) => (b.rate > a.rate ? b : a));
  const worst = rows.reduce((a, b) => (b.rate < a.rate ? b : a));

  // 趋势：后半段平均 vs 前半段平均。少于 4 条时样本不足以说趋势，直接说不知道。
  let trend = 0;
  if (rows.length >= 4) {
    const half = Math.floor(rows.length / 2);
    const avgOf = (arr) => arr.reduce((s, r) => s + r.rate, 0) / arr.length;
    trend = avgOf(rows.slice(rows.length - half)) - avgOf(rows.slice(0, half));
  }

  // 按科目题型分组小计
  const gmap = new Map();
  for (const r of rows) {
    const k = `${r.track}_${r.task}`;
    if (!gmap.has(k)) gmap.set(k, { key: k, track: r.track, task: r.task, max: r.max, count: 0, sum: 0 });
    const g = gmap.get(k);
    g.count++; g.sum += r.rate;
  }
  const groups = [...gmap.values()].map((g) => ({ ...g, avgRate: g.sum / g.count }));

  return {
    points: rows,
    stats: {
      count: rows.length,
      avgRate: avg,
      best, worst,
      trend,
      trendLabel: rows.length < 4
        ? '样本太少，暂不判断趋势'
        : trend > 0.02 ? '最近在进步'
          : trend < -0.02 ? '最近有回落' : '基本持平',
    },
    groups,
  };
}

const pct = (r) => Math.round(r * 100);
const fmtDay = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
// SVG 文本/属性里 & < > " ' 要转义
function escAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 画成绩曲线（纯 SVG 字符串，零依赖）。y 轴按数据自适应并标出端点值，
// 每个点也标了百分比——不是从 0 起的裁剪轴，但数值一个不落。
export function renderScoreChart(curve) {
  const pts = (curve && curve.points) || [];
  if (!pts.length) return { svg: '', empty: true };

  const W = 400, H = 170, PL = 34, PR = 12, PT = 16, PB = 26;
  const iw = W - PL - PR, ih = H - PT - PB;

  const rates = pts.map((p) => p.rate);
  const lo = Math.min(...rates), hi = Math.max(...rates);
  const pad = Math.max(0.03, (hi - lo) * 0.3);
  let y0 = Math.max(0, lo - pad), y1 = Math.min(1, hi + pad);
  if (y1 - y0 < 0.06) { const c = (y0 + y1) / 2; y0 = Math.max(0, c - 0.04); y1 = Math.min(1, c + 0.04); }

  const t0 = pts[0].at, t1 = pts[pts.length - 1].at, span = t1 - t0;
  const X = (i) => (span > 0 ? PL + ((pts[i].at - t0) / span) * iw : PL + iw / 2);
  const Y = (r) => PT + ih * (1 - (r - y0) / (y1 - y0 || 1));

  const grid = [y0, (y0 + y1) / 2, y1].map((v) =>
    `<line x1="${PL}" y1="${Y(v).toFixed(1)}" x2="${W - PR}" y2="${Y(v).toFixed(1)}" stroke="var(--hairline)" stroke-width="1"/>
     <text x="${PL - 6}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)" font-family="var(--sans)">${pct(v)}%</text>`
  ).join('');

  const avg = curve.stats ? curve.stats.avgRate : 0;
  const meanLine = (avg >= y0 && avg <= y1)
    ? `<line x1="${PL}" y1="${Y(avg).toFixed(1)}" x2="${W - PR}" y2="${Y(avg).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>`
    : '';

  const coords = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.rate).toFixed(1)}`).join(' ');
  const poly = pts.length > 1
    ? `<polyline points="${coords}" fill="none" stroke="var(--ink)" stroke-width="1.5" stroke-linejoin="miter" stroke-linecap="square"/>`
    : '';

  const showVals = pts.length <= 8;
  const dots = pts.map((p, i) => {
    const last = i === pts.length - 1;
    const x = X(i), y = Y(p.rate);
    const color = last ? 'var(--accent)' : 'var(--ink)';
    const s = last ? 5 : 4;
    return `<g class="dg-point" data-id="${p.id}" role="button" tabindex="0" aria-label="${escAttr(`${fmtDay(p.at)} ${p.score}/${p.max} 分`)}">
      <rect x="${(x - s / 2).toFixed(1)}" y="${(y - s / 2).toFixed(1)}" width="${s}" height="${s}" fill="${color}"/>
      <title>${escAttr(`${fmtDay(p.at)} · ${p.score}/${p.max} 分（${pct(p.rate)}%）`)}</title>
    </g>` + (showVals
      ? `<text x="${x.toFixed(1)}" y="${(y - 9).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--muted)" font-family="var(--sans)">${pct(p.rate)}%</text>`
      : '');
  }).join('');

  const xLabels = pts.length > 1
    ? `<text x="${PL}" y="${H - 7}" font-size="9" fill="var(--muted)" font-family="var(--sans)">${fmtDay(t0)}</text>
       <text x="${W - PR}" y="${H - 7}" text-anchor="end" font-size="9" fill="var(--muted)" font-family="var(--sans)">${fmtDay(t1)}</text>`
    : `<text x="${(PL + iw / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="9" fill="var(--muted)" font-family="var(--sans)">${fmtDay(t0)}</text>`;

  const svg = `<svg viewBox="0 0 ${W} ${H}" class="dg-chart" role="img" aria-label="历史得分率曲线">
    ${grid}${meanLine}${poly}${dots}${xLabels}
  </svg>`;
  return { svg, empty: false };
}

// —— 报告渲染（纯函数）——
// 放在 core.js 而不是 ui.js，是为了让报告模板能在 Node 里被渲染出来：
// README 的界面截图、以及将来的"导出 Markdown"都用这一份代码，不会出现两套渲染慢慢分叉。
export const TRACKS = { 'english-i': '英语一', 'english-ii': '英语二' };
export const TASKS = { large: '大作文 Part B', small: '小作文 Part A' };
// 级别中英兼容显示（内核 v1.4 起为中文；旧历史记录是英文枚举）
export const SEV_DISP = { '错误': '错误', '欠佳': '欠佳', '润色': '润色', error: '错误', awkward: '欠佳', style: '润色' };
export const SEV_CLS = { '错误': 'error', '欠佳': 'awkward', '润色': 'style', error: 'error', awkward: 'awkward', style: 'style' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderReportHtml(final, facts, opts = {}) {
  const track = final?.report_a?.meta?.exam_track || opts.track || 'english-ii';
  const task = final?.report_a?.meta?.task || opts.task || 'large';
  const maxScore = MAX_SCORES[`${track}_${task}`] || 15;
  const [ia, ib] = final?.initial || [];
  const dims = final?.dimensions || [];
  const edits = final?.report_b?.sentence_edits || final?.report_a?.sentence_edits || [];
  const rep = final?.decision === 'pick_b' ? final?.report_b : final?.report_a;
  const flags = facts?.mechanical_flags || [];
  const modelLabel = final?.report_a?.meta?.grader_model || opts.model || '';

  return `
  <section class="card">
    <h2><span class="dot"></span>终裁报告</h2>
    <div class="score-hero">
      <div class="score-big">${esc(final?.final_score)}<small> / ${maxScore}</small></div>
      <div class="score-meta">
        <span>科目题型</span><b>${TRACKS[track] || track} · ${TASKS[task] || task}</b>
        <span>档位</span><b>第 ${esc(final?.final_band)} 档（${esc(String(final?.final_range || ''))}）</b>
        <span>字数</span><b>${esc(String(facts?.word_count ?? '?'))} 词（预检脚本）</b>
        ${modelLabel ? `<span>阅卷模型</span><b>${esc(modelLabel)}</b>` : ''}
      </div>
    </div>
    ${dualRail(final || {}, maxScore, ia, ib)}
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
}

// 供应商信息（纯函数）：设置面板渲染与截图工具共用同一份逻辑，避免两处各写一遍字符串
export function provInfo(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    statusLabel: p.status ? STATUS_LABEL[p.status] : '',
    statusClass: { ok: 'ok', blocked: 'bad', local: 'mut' }[p.status] || 'mut',
    blurb: p.blurb || '',
    note: p.note || '',
    keyUrl: p.keyUrl || '',
    keyLabel: p.keyUrl ? `去 ${p.name.replace(/ 官方| · 内置算力| 本地/g, '')} 控制台申请 Key →` : '',
  };
}

export function validateReport(report, essayText) {
  const failures = [], warnings = [];
  const essayNorm = essayText.trim().split(/\s+/).join(' ');
  const norm = (s) => String(s || '').trim().split(/\s+/).join(' ');

  // 必填字段（与 validate_report.py 同口径）：缺字段一律打回
  for (const field of ['meta', 'band', 'scores', 'consistency', 'sentence_edits', 'improved_version', 'top_problems']) {
    if (!(field in report)) failures.push(`缺少必填字段: ${field}`);
  }

  const meta = report.meta || {};
  const key = `${meta.exam_track}_${meta.task}`;
  if (!(key in MAX_SCORES) || MAX_SCORES[key] !== meta.max_score)
    failures.push(`meta 组合非法：${meta.exam_track}/${meta.task}/${meta.max_score}`);
  if (!Number.isInteger(meta.word_count_reported) || meta.word_count_reported <= 0)
    failures.push('meta.word_count_reported 必须为正整数（引用预检值）');

  const band = report.band || {}, b = band.band;
  if (!Number.isInteger(b) || !(BAND_TABLE[meta.max_score] || {})[b]) failures.push(`档位非法: ${b}`);
  else {
    const expect = BAND_TABLE[meta.max_score][b];
    if (String(band.range) !== String(expect)) failures.push(`档位区间错: ${JSON.stringify(band.range)}，应为 ${JSON.stringify(expect)}`);
  }
  if (String(band.rationale || '').length < 20) failures.push('band.rationale 太短，须引用档位描述关键词');

  const dims = (report.scores?.dimensions) || [];
  let sum = 0;
  for (const d of dims) {
    if (!(d.score >= 0 && d.score <= d.max + EPS)) failures.push(`维度 ${d.name} 分值越界: ${d.score}/${d.max}`);
    if (norm(d.evidence).length < 5) failures.push(`维度 ${d.name} 缺少原文证据`);
    sum += d.score || 0;
  }
  if (!dims.length) failures.push('维度分为空');
  const total = report.scores?.total;
  if (Math.abs(sum - total) > EPS) failures.push(`维度分之和 ${sum} != 总分 ${total}`);
  if (Number.isInteger(b) && BAND_TABLE[meta.max_score]?.[b]) {
    const [lo, hi] = BAND_TABLE[meta.max_score][b];
    if (!(lo - EPS <= sum && sum <= hi + EPS)) failures.push(`维度分之和 ${sum} 不在档位区间 [${lo}, ${hi}] 内`);
  }
  if (report.consistency?.in_band_range !== true) failures.push('consistency.in_band_range 必须为 true');
  // consistency.dimension_sum 必须与维度分之和一致（与 validate_report.py 同口径，
  // 旧实现漏了这一项，导致网页放行、Skill 打回，两条路径对同一报告结论不同）
  if (report.consistency && Math.abs((report.consistency.dimension_sum ?? -1) - sum) > EPS) {
    failures.push('consistency.dimension_sum 与维度分之和不符');
  }

  (report.sentence_edits || []).forEach((e, i) => {
    const sev = SEV_ALIAS[e.severity];
    if (!sev) failures.push(`逐句批改[${i}] severity 非法: ${e.severity}`);
    if (sev === 'style' && /错误/.test(negated(e.issue || ''))) failures.push(`逐句批改[${i}] 润色级不得使用"错误"措辞（否定式除外）`);
    if (norm(e.original) && !essayNorm.includes(norm(e.original))) warnings.push(`逐句批改[${i}] original 与原文不符`);
  });

  (report.reusable?.patterns || []).forEach((p, i) => {
    const low = String(p).toLowerCase();
    const hit = REUSABLE_BLACKLIST.find((b) => low.includes(b));
    if (hit) failures.push(`可复用 patterns[${i}] 含模板套话 '${hit}'，须换成本题骨架（rubric 5.2）`);
    else if (!low.includes('...') && !low.includes('___')) warnings.push(`可复用 patterns[${i}] 建议改为带 .../___ 填空位的句式骨架`);
  });

  const n = (report.top_problems || []).length;
  if (!(n >= 2 && n <= 3)) failures.push(`top_problems 应为 2-3 条，实际 ${n} 条`);
  return { failures, warnings };
}

// —— 同档合并（rubric v1.2：确定性算术，与 average_reports.py 同口径） ——
export function mergeSameBand(a, b) {
  const ba = a.band.band, bb = b.band.band;
  if (ba !== bb) return { ok: false, reason: 'arbiter' };
  const da = Object.fromEntries((a.scores?.dimensions || []).map((d) => [d.name, d]));
  const db = Object.fromEntries((b.scores?.dimensions || []).map((d) => [d.name, d]));
  const names = Object.keys(da);
  // 维度比较必须与 average_reports.py 同口径：按集合比（顺序无关）。
  // 旧实现用 names.join() 比字符串，LLM 阅卷员输出顺序一不同就被判成"维度不一致"，
  // 而同档本应走确定性均值合并——这是两条路径结论不一致的根源。
  const setB = new Set(Object.keys(db));
  if (names.length !== setB.size || names.some((n) => !setB.has(n))) {
    const onlyA = names.filter((n) => !setB.has(n));
    const onlyB = [...setB].filter((n) => !names.includes(n));
    return { ok: false, reason: 'dimension_names', detail: { only_a: onlyA, only_b: onlyB } };
  }
  const dims = names.map((n) => ({
    name: n, max: da[n].max, score: (da[n].score + db[n].score) / 2,
    note: `A给${da[n].score}，B给${db[n].score}，均值${(da[n].score + db[n].score) / 2}`,
  }));
  const dimSum = dims.reduce((s, d) => s + d.score, 0);
  const total = snapHalfDown(dimSum);
  const maxScore = a.meta.max_score;
  const [lo, hi] = BAND_TABLE[maxScore][ba];
  if (!(lo <= total && total <= hi)) return { ok: false, reason: 'out_of_band' };
  return {
    ok: true,
    final: {
      needs_regrade: false, decision: 'same_band',
      final_band: ba, final_score: total, final_range: [lo, hi],
      dimensions: dims,
      rationale: `两位阅卷员同档（band_gap=0），按 rubric 第7节逐维取均值、总分收敛至0.5粒度（尾数从严），脚本确定性合并。`,
      initial: [
        { grader: 'A', band: ba, score: a.scores.total },
        { grader: 'B', band: bb, score: b.scores.total },
      ],
      band_gap: 0,
      score_gap: Math.abs(a.scores.total - b.scores.total),
      report_a: a, report_b: b,
    },
  };
}

// —— 提示词（内核 v1.0）：优先使用 prompts/ 文件模板，缺省用内置兜底 ——
const BUILTIN_GRADER_SYSTEM = '你是一名独立的考研英语作文阅卷员，参加双盲阅卷。你只能使用用户消息中列出的材料，忽略其他一切上下文。严格按评分规则执行，最终只输出一个 JSON 对象本体（不要解释、不要 markdown 围栏）。';
const BUILTIN_GRADER_TASK = `【评分规则（唯一依据，完整阅读）】
{{RUBRIC}}

【输出契约（JSON Schema）】
{{SCHEMA}}

【事实清单（字数与段落由脚本计算，只准引用不准自算）】
{{FACTS}}

【题面】
{{PROMPT}}

【考生作文】
{{ESSAY}}

严格按规则第 6 节"评分流程"执行，特别注意：第 5 节三级错误分类（拿不准一律降级，宁漏勿冤）；维度分之和必须落在档位区间内。输出完全符合 schema 的 JSON 报告。`;

function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{{${k}}}`);
}

export function graderMessages({ rubric, schema, facts, prompt, essay, kernel }) {
  const sys = kernel?.graderSystem || BUILTIN_GRADER_SYSTEM;
  const tpl = kernel?.graderTask || BUILTIN_GRADER_TASK;
  const user = fillTemplate(tpl, {
    RUBRIC: rubric, SCHEMA: schema, FACTS: JSON.stringify(facts),
    PROMPT: prompt || '未提供——切题维度按暂定处理', ESSAY: essay,
  });
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

export function arbiterMessages({ rubric, essay, prompt, reportA, reportB, kernel }) {
  const sys = kernel?.graderSystem
    ? '你是考研英语作文双盲阅卷的仲裁员。只输出一个 JSON 对象本体（不要解释、不要 markdown 围栏）。'
    : '你是考研英语作文双盲阅卷的仲裁员。只输出一个 JSON 对象本体（不要解释、不要 markdown 围栏）。';
  const tpl = kernel?.arbiterTask;
  let user;
  if (tpl) {
    user = fillTemplate(tpl, {
      RUBRIC: rubric, ESSAY: essay, PROMPT: prompt || '未提供',
      REPORT_A: JSON.stringify(reportA), REPORT_B: JSON.stringify(reportB),
    });
  } else {
    user = [
      '【评分规则（重点读第 2、3、7 节）】', rubric, '',
      '【考生作文】', essay, '',
      '【题面】', prompt ? prompt : '未提供', '',
      '【阅卷员 A 报告】', JSON.stringify(reportA), '',
      '【阅卷员 B 报告】', JSON.stringify(reportB), '',
      '按规则第 7 节双评与仲裁协议裁决：差一档必须在两个档位中二选一并引用档位描述原文说明依据，不允许和稀泥取中间分；差两档及以上 needs_regrade=true。',
      '输出 JSON：{"needs_regrade":bool,"decision":"pick_a|pick_b|void","final_band":int,"final_score":number,"final_range":[lo,hi],"dimensions":[{"name","max","score","note"}],"rationale":"引用档位描述的裁决理由","initial":[{"grader":"A","band":int,"score":number},{"grader":"B","band":int,"score":number}],"band_gap":int,"score_gap":number}',
    ].join('\n');
  }
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

export function repairMessages(baseMessages, badOutput, problems) {
  return [
    ...baseMessages,
    { role: 'assistant', content: String(badOutput).slice(0, 12000) },
    { role: 'user', content: `你上一条输出的报告未通过机器校验，问题如下：\n${problems.map((p) => '- ' + p).join('\n')}\n请修正这些问题，重新输出完整的、完全符合 schema 的 JSON 报告。只输出 JSON 本体。` },
  ];
}

// 是否给这次请求附加设备指纹：只在内置算力（邀请码代理）通道发。
// 抽成纯函数是为了可测——用户自配 API Key 直连第三方时不应把设备标识泄漏出去。
export function shouldSendDeviceId(settings) {
  return settings?.preset === 'invite';
}

// 设备指纹：与服务端 IP 双重计数，抬高清 IP 刷免费额度的成本（存 localStorage，清数据才会变）。
// 只在内置算力（邀请码代理）通道发送——用户自配 API Key 直连第三方时，不应把设备标识泄漏出去。
function didHdr(settings) {
  if (!shouldSendDeviceId(settings)) return '';
  try {
    let d = localStorage.getItem('duograder_did');
    if (!d) { const a = new Uint8Array(6); crypto.getRandomValues(a); d = 'd' + Date.now().toString(36) + [...a].map((b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('duograder_did', d); }
    return d;
  } catch { return ''; }
}

// —— API 诊断（仿主流 harness 的连接检查） ——
// 无 key 探测：只要浏览器能"读到"任意 HTTP 状态码（包括 401），就证明跨域直连可行
export function probeCors(baseURL, timeoutMs = 8000) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  return fetch(base + '/models', { headers: { Authorization: 'Bearer sk-duograder-cors-probe' }, signal: ctrl.signal })
    .then((res) => ({ ok: true, status: res.status, ms: Date.now() - t0 }))
    .catch((e) => ({ ok: false, status: 0, ms: Date.now() - t0, error: e.name === 'AbortError' ? '超时' : 'fetch 失败' }))
    .finally(() => clearTimeout(timer));
}

export function fetchModelList({ baseURL, apiKey }) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  return fetch(base + '/models', { headers: { Authorization: 'Bearer ' + (apiKey || '') } })
    .then(async (res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const ids = [...new Set((Array.isArray(j) ? j : (j.data || [])).map((m) => m.id || m.name).filter(Boolean))].sort();
      if (!ids.length) throw new Error('返回中没有模型');
      return ids;
    });
}

export function chatTestMessages() {
  return [{ role: 'user', content: '只回复两个字：正常' }];
}

export function visionTestMessages(imageDataUrl) {
  return [
    { role: 'system', content: '你看图回答问题，答案只有几个字。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张纯色小图是什么颜色？只回答颜色名。' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

export function httpErrorHint(status) {
  return {
    401: 'API Key 无效或未填',
    403: '无权限 / 欠费 / 地域限制',
    404: '地址路径或模型名不对',
    429: '限流，稍后再试',
  }[status] || (status >= 500 ? '服务商内部错误' : '');
}

// —— 拍照转写（视觉模型读手写） ——
// 合并模式：题面与手写作文可能在同一张/一组照片里，由模型分离
// 手写修改痕迹规则：划线删除=不计入正文（收进 crossed_out）；旁注/行间插入=按插入位置并入正文
const STRIKETHROUGH_RULES = '考生手写作文常见修改痕迹，必须正确处理：①被横线/斜线划掉的内容＝已删除，不要计入 essay 正文，逐条原样收进 crossed_out 数组；②写在划掉处上方/左方/右方的旁注、或行间插入的小字（通常有插入符号 ^ ）＝考生想替换成的修改，按其位置并入 essay 正文对应位置；③拿不准是划掉还是正常书写时，按正常书写保留（宁可保留，交给用户核对）；④划掉/旁注无法辨认的词用 [?]。\n忠实性铁律：逐词转写＝按你看到的字母转写。即使某个词看起来像拼写笔误，也**原样保留**，严禁根据语义"纠正"成正确拼写或近义词（例如不得把看似写错的词替换成词典词）；拿不准的字母/词用 [?] 占位，交给用户核对。';

export function transcriptionMessages(imageDataUrls, kind) {
  if (kind === 'combined') {
    return [
      { role: 'system', content: '你是手写照片转写助手，只输出一个 JSON 对象本体，不要解释，不要围栏。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: `照片里是考研英语作文的完整材料：可能包含印刷的题面（Directions、图表/图画说明）和考生手写的作文（手写部分可能在多张照片中连续）。请分离并转写为 JSON：\n{"prompt": "印刷题面全文（含图表数据说明；若照片里没有题面则输出空字符串）", "essay": "考生手写作文全文（逐词转写，不纠错不改写，保留拼写错误；段落间用一个空行分隔；无法辨认的词用 [?]；多张照片按顺序拼接）", "crossed_out": ["被划线划掉的内容，原样；没有则空数组"], "task_guess": "large 或 small 或 unknown（按题面判断）", "track_guess": "english-i 或 english-ii 或 unknown", "evidence": "判断依据一句话；若题面与 2010-2026 历年真题吻合，写明「20XX年英语X Part A/B 真题匹配」，否则写体裁特征"}\n${STRIKETHROUGH_RULES}\n判别特征：大作文看体裁——图画/漫画→英语一，图表/表格→英语二；**图画+图表混合题（如 2022 年英一）不能按体裁判科目**，以题面字数/分值为准（160-200词/20分→英语一，约150词/15分→英语二）；小作文约100词书信/通知，英一英二重叠，须靠真题年份匹配（年份+科目+题型+话题都吻合才算匹配，记忆不一致就以照片为准）。手写作文里可能引用题面的词，凡是手写体都属于 essay；印刷体/照片描述属于 prompt。只输出 JSON。` },
          ...imageDataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
        ],
      },
    ];
  }
  const instruction = kind === 'prompt'
    ? '转写图片中的考研英语作文题面（可能包含 Directions、要求、分值，以及图表或图画的文字描述）。完整保留全部信息，中文说明照原样保留，段落间用空行。只输出转写文本本体，不要解释，不要围栏。'
    : `转写图片中的手写英语作文。逐词转写：不要纠错、不要补全、不要改写考生写的内容（拼写错误也原样保留）；保留段落结构，段落之间用一个空行分隔；无法辨认的词用 [?] 占位；多张图片按顺序是同一篇作文的连续部分。只输出转写文本本体，不要解释，不要围栏。\n${STRIKETHROUGH_RULES}\n（本模式只输出 essay 正文文本本体；划掉内容直接跳过。）`;
  return [
    { role: 'system', content: '你是手写照片转写助手，只输出转写结果文本。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        ...imageDataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
      ],
    },
  ];
}

// —— API 调用（OpenAI 兼容）：默认 60s 超时 + 429/5xx/网络错误指数退避重试 ——
// bodyExtra：附加到请求体的额外字段（如 reasoning_effort），代理对客户端显式值不覆盖
export async function callChat(settings, messages, { temperature = 0.3, signal, timeout = 60000, retries = 2, onUsage, bodyExtra } = {}) {
  const base = String(settings.baseURL || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API 地址（设置里选一个预设或填 baseURL）');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const onOuterAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw new Error('已取消'); }
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      const did = didHdr(settings);
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (settings.apiKey || ''), ...(did ? { 'X-Device-Id': did } : {}) },
        body: JSON.stringify({ model: settings.model, messages, temperature, stream: false, ...(bodyExtra || {}) }),
        signal: ctrl.signal,
      });
      // 免费额度：服务端在匿名响应头里带回剩余次数，广播给 UI 角标
      try {
        const fr = res.headers.get('X-Free-Remaining');
        if (fr !== null) window.dispatchEvent(new CustomEvent('dg-free', { detail: Number(fr) }));
      } catch {}
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        const err = new Error(`API 返回 HTTP ${res.status}: ${t.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('API 返回为空：' + JSON.stringify(data).slice(0, 200));
      if (onUsage && data.usage) onUsage(data.usage);
      return content;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw new Error('已取消');
      const timedOut = e.name === 'AbortError';
      const retryable = timedOut || e.status === 429 || e.status >= 500 || e.name === 'TypeError';
      if (!retryable || attempt === retries) {
        if (timedOut) throw new Error(`请求超时（${timeout / 1000}s）`);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // 1s → 2s
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }
  throw lastErr;
}

export const PRESETS = [
  // status: ok=浏览器可直连 / blocked=浏览器被拦 / local=仅本地 http 页（2026-10-09 实测）
  // invite=邀请码模式：走分享者的 Pages Function 代理（api key 存服务端，前端只持邀请码）。
  // 同域 duograder.pages.dev 国内可直连；备用 Worker（workers.dev）仅作海外/自托管参考。
  // blurb=给新手的"选哪个"（仿主流 harness 的 provider 选择器）；keyUrl=去拿 Key 的控制台。
  { id: 'invite', name: '邀请码 · 内置算力', status: 'ok', baseURL: 'https://duograder.pages.dev/v1', model: 'MiniMax-M3.1-Flash-Preview', vmodel: 'MiniMax-M3.1-Flash-Preview',
    blurb: '什么都不用配，每 IP 免费批改 50 次', keyUrl: '' },
  { id: 'deepseek', name: 'DeepSeek 官方', status: 'ok', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', vmodel: 'deepseek-flash',
    blurb: '最便宜，中文批改性价比高 · 新手首选', keyUrl: 'https://platform.deepseek.com/api_keys', keyRe: /^sk-[A-Za-z0-9]{32}$/ },
  { id: 'glm', name: '智谱 GLM 官方', status: 'ok', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', vmodel: 'glm-4v-flash',
    blurb: '国产老牌，GLM 中文书感好', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', keyRe: /^[A-Za-z0-9]{16}\.[A-Za-z0-9]{16}$/ },
  { id: 'kimi', name: 'Kimi 月之暗面', status: 'ok', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', vmodel: 'moonshot-v1-8k-vision-preview',
    blurb: '长上下文强，适合一次丢整篇材料', keyUrl: 'https://platform.moonshot.cn/console/api-keys', keyRe: /^sk-[A-Za-z0-9]{48}$/ },
  { id: 'qwen', name: '通义千问 · 百炼', status: 'ok', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vmodel: 'qwen-vl-plus',
    blurb: '阿里百炼，通义系列，认字稳', keyUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'ark', name: '火山方舟 · 豆包', status: 'blocked', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1.5-pro-32k', vmodel: 'doubao-1.5-vision-pro-32k',
    blurb: '豆包，便宜量大', keyUrl: 'https://console.volcengine.com/ark',
    note: '浏览器直连被拦 · 需用桌面壳或本地反代' },
  { id: 'openai', name: 'OpenAI 官方', status: 'ok', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o', vmodel: 'gpt-4o-mini',
    blurb: 'GPT-4o，通用能力均衡', keyUrl: 'https://platform.openai.com/api-keys', keyRe: /^sk-(proj-)?[A-Za-z0-9_-]{20,}$/ },
  { id: 'anthropic', name: 'Anthropic Claude', status: 'blocked', baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', vmodel: 'claude-sonnet-4-5',
    blurb: 'Claude 最会改句子', keyUrl: 'https://console.anthropic.com/',
    note: '浏览器直连被拦 · 需用桌面壳或本地反代' },
  { id: 'gemini', name: 'Google Gemini', status: 'ok', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', vmodel: 'gemini-2.0-flash',
    blurb: '免费额度大，Google 生态', keyUrl: 'https://aistudio.google.com/app/apikey', keyRe: /^AIza/ },
  { id: 'siliconflow', name: '硅基流动', status: 'ok', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', vmodel: 'deepseek-ai/DeepSeek-VL2',
    blurb: '一个 Key 调各家开源模型', keyUrl: 'https://cloud.siliconflow.cn/' },
  { id: 'openrouter', name: 'OpenRouter', status: 'ok', baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', vmodel: 'google/gemini-2.0-flash-001',
    blurb: '一个 Key 调几十家模型 · 有免费模型可白嫖', keyUrl: 'https://openrouter.ai/keys', keyRe: /^sk-or-v1-/ },
  { id: 'ollama', name: 'Ollama 本地', status: 'local', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', vmodel: 'qwen2.5vl:7b',
    blurb: '完全本地，作文不出电脑', keyUrl: 'https://ollama.com/library', note: '需先装 Ollama · 只有电脑能连，手机打不开' },
  { id: 'lmstudio', name: 'LM Studio 本地', status: 'local', baseURL: 'http://localhost:1234/v1', model: 'local-model', vmodel: '',
    blurb: '完全本地，图形界面装模型', keyUrl: 'https://lmstudio.ai', note: '需先装 LM Studio · 只有电脑能连，手机打不开' },
  { id: 'custom', name: '自定义供应商', status: null, baseURL: '', model: '', vmodel: '',
    blurb: '自建反代 / 中转站 / 其它兼容 OpenAI 的服务', keyUrl: '' },
];
export const STATUS_LABEL = { ok: '可直连', blocked: '需反代', local: '仅本地' };

// Key 前缀 → 供应商（只认前缀唯一的；贴 Key 时自动切换供应商用）
const KEY_PREFIX = [
  { id: 'openrouter', re: /^sk-or-v1-/i },
  { id: 'anthropic', re: /^sk-ant-/i },
  { id: 'openai', re: /^sk-proj-/i },
  { id: 'gemini', re: /^AIza/ },
  { id: 'glm', re: /^[A-Za-z0-9]{16}\.[A-Za-z0-9]{16}$/ },
  { id: 'ark', re: /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/ },
];

// 贴 Key → 猜供应商。返回 null 表示前缀不唯一（国内几家都是 sk- 开头），不乱猜。
export function detectProviderByKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const hit = KEY_PREFIX.find((p) => p.re.test(k));
  return hit ? hit.id : null;
}

// Key 与所选供应商"看起来不像"？只作软提示，绝不拦（各家格式会变，猜错不该阻断可用配置）
export function keyLooksMismatched(presetId, key) {
  const p = PRESETS.find((x) => x.id === presetId);
  const k = String(key || '').trim();
  if (!p?.keyRe || !k) return null;
  return p.keyRe.test(k) ? null : p.name;
}
