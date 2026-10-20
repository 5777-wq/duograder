// 生成 README 用的界面截图页面：node scripts/preview_shots.mjs
//
// 关键点：这些页面不是手搓的静态稿，而是
//   · HTML  = 真实的 app/index.html
//   · CSS   = 真实的 app/style.css
//   · 内容  = 用真实的 app/core.js 渲染函数（renderReportHtml / renderScoreChart）产出
//   · 数据  = docs/validation/ 里的真实存档报告（graderA/graderB/final_report）
// 只做三件事：把路径改成相对 app/ 的、去掉脚本标签、把目标状态注入进去。
// 人工手抄一遍 HTML 迟早会和真实界面分叉，那样截图就骗人了。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReportHtml, buildScoreCurve, renderScoreChart, provInfo, esc, mergeSameBand } from '../app/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'shots');

const read = (p) => readFileSync(path.join(ROOT, p), 'utf-8');
const readJson = (p) => JSON.parse(read(p));

/* ---------- 取真实数据 ---------- */
const graderA = readJson('docs/validation/2026-10-08/graderA.json');
const graderB = readJson('docs/validation/2026-10-08/graderB.json');
const archivedFinal = readJson('docs/validation/2026-10-08/final_report.json');

// 终裁报告用真实的 mergeSameBand 重算，而不是直接用存档的 final_report.json：
// 那份存档是旧内核的产物（A/B 都给 8.5、终裁写 7），内部不自洽，
// 直接拿来截图会画出"终裁比两位阅卷员都低"的矛盾画面。
const merged = mergeSameBand(graderA, graderB);
if (!merged.ok) throw new Error('存档的两份报告当前内核下无法合并：' + merged.reason);
const final = { ...merged.final, rationale: archivedFinal.rationale || merged.final.rationale };

// 预检事实清单用真实的 precheck.py 跑出来，不手写
const facts = JSON.parse(execFileSync('python', [
  path.join(ROOT, 'skill', 'kaoyan-essay', 'scripts', 'precheck.py'),
  path.join(ROOT, 'skill', 'kaoyan-essay', 'tests', 'fixtures', 'essay-synthetic-flawed.txt'),
  '--track', 'english-ii', '--task', 'large',
], { encoding: 'utf-8' }));

/* ---------- 页面骨架：真实的 index.html ---------- */
function basePage() {
  let html = read('app/index.html');
  // 资源路径改成相对 docs/shots/ 的
  html = html.replace(/href="style\.css"/, 'href="../../app/style.css"')
    .replace(/href="manifest\.json"/, 'href="../../app/manifest.json"')
    .replace(/href="logo\.svg"/, 'href="../../app/logo.svg"')
    .replace(/href="icon-192\.svg"/g, 'href="../../app/icon-192.png"')
    .replace(/src="logo\.svg"/g, 'src="../../app/logo.svg"')
    .replace(/src="icon-192\.png"/g, 'src="../../app/icon-192.png"');
  // 去掉脚本：截图要的是静态终态，不要动画中途
  html = html.replace(/<script type="module" src="ui\.js"><\/script>/, '');
  return html;
}
const inject = (html, sel, content) => html.replace(sel, content);

/* ---------- ① 终裁报告 ---------- */
{
  let html = basePage();
  html = html.replace('<body>', '<body class="reviewing">');
  html = inject(html, '<div id="report-area"></div>', `<div id="report-area">${renderReportHtml(final, facts, { model: 'MiniMax-M3.1-Flash-Preview' })}</div>`);
  html = inject(html, '<div id="report-area">', '<div id="report-area">');
  // 复刻"只看终裁报告"的返回按钮
  html = html.replace('</div>\n\n<footer>', '<button class="icon-btn review-back">← 返回</button></div>\n\n<footer>');
  writeFileSync(path.join(OUT, 'report.html'), html, 'utf-8');
  console.log('✓ docs/shots/report.html');
}

/* ---------- ② API 设置 ---------- */
{
  let html = basePage();
  const info = provInfo('deepseek');
  html = html.replace('<div class="modal-mask" id="modal-mask"></div>', '<div class="modal-mask show" id="modal-mask"></div>');
  html = html.replace('<div class="modal" id="modal-settings">', '<div class="modal show" id="modal-settings">');
  html = html.replace('<span id="prov-current">DeepSeek 官方</span>', `<span id="prov-current">${esc(info.name)}</span>`);
  html = html.replace('<span class="p-status mut" id="prov-status">可直连</span>', `<span class="p-status ${info.statusClass}" id="prov-status">${esc(info.statusLabel)}</span>`);
  html = html.replace('<div class="hint" id="prov-blurb"></div>', `<div class="hint" id="prov-blurb">${esc(info.blurb)}</div>`);
  html = html.replace('<input type="password" id="set-key" placeholder="sk-..." autocomplete="off" />',
    '<input type="text" id="set-key" value="sk-3f9a••••••••••••••••••••••" readonly />');
  html = html.replace('<div class="hint" id="key-hint"></div>', '<div class="hint ok" id="key-hint">✓ 格式与 DeepSeek 官方 匹配</div>');
  html = html.replace('<a class="key-link" id="key-link" target="_blank" rel="noopener">去控制台申请 Key →</a>',
    `<a class="key-link" id="key-link" href="${info.keyUrl}" target="_blank" rel="noopener">${esc(info.keyLabel)}</a>`);
  writeFileSync(path.join(OUT, 'settings.html'), html, 'utf-8');
  console.log('✓ docs/shots/settings.html');
}

/* ---------- ③ 历史成绩曲线 ---------- */
{
  // 示意图数据：得分率真实，篇数与日期为演示用（README 里会标明是示意图）
  const hist = [
    { id: 1758000000000, track: 'english-ii', task: 'large', ts: '9/08 21:10', final: { final_score: 8.5, final_band: 3 } },
    { id: 1758400000000, track: 'english-ii', task: 'large', ts: '9/13 20:05', final: { final_score: 9.5, final_band: 3 } },
    { id: 1758700000000, track: 'english-ii', task: 'small', ts: '9/17 09:32', final: { final_score: 7, final_band: 3 } },
    { id: 1759000000000, track: 'english-ii', task: 'large', ts: '9/21 22:40', final: { final_score: 11, final_band: 4 } },
    { id: 1759400000000, track: 'english-i', task: 'large', ts: '9/26 19:15', final: { final_score: 12, final_band: 4 } },
    { id: 1759700000000, track: 'english-ii', task: 'large', ts: '10/01 21:03', final: { final_score: 10.5, final_band: 4 } },
    { id: 1760000000000, track: 'english-ii', task: 'large', ts: '10/05 18:47', final: { final_score: 12, final_band: 4 } },
    { id: 1760400000000, track: 'english-ii', task: 'large', ts: '10/10 20:22', final: { final_score: 13.5, final_band: 4 } },
  ];
  const curve = buildScoreCurve(hist);
  const st = curve.stats;
  const chart = renderScoreChart(curve);
  const delta = st.trend === 0 ? '' : ` <b>${st.trend > 0 ? '↑' : '↓'} ${Math.abs(Math.round(st.trend * 100))}%</b>`;
  const curveHtml = `
    <div class="curve-stats">
      <div class="cs"><span>批改</span><b>${st.count} 篇</b></div>
      <div class="cs"><span>平均得分率</span><b>${Math.round(st.avgRate * 100)}%</b></div>
      <div class="cs"><span>最高</span><b>${Math.round(st.best.rate * 100)}%</b></div>
      <div class="cs"><span>最低</span><b>${Math.round(st.worst.rate * 100)}%</b></div>
    </div>
    <div class="curve-trend">${esc(st.trendLabel)}${delta}</div>
    ${chart.svg}
    <div class="curve-hint">纵轴是<b>得分率</b>（得分 ÷ 该题型满分）——三种题型满分不同，不折算没法比。点某个点可看那次的报告。</div>
    <div class="curve-groups">
      ${curve.groups.map((g) => `<div class="cg"><span>${esc(g.track === 'english-i' ? '英语一' : '英语二')} · ${esc(g.task === 'large' ? '大作文 Part B' : '小作文 Part A')}</span><b>${g.count} 篇 · 均 ${Math.round(g.avgRate * 100)}%</b></div>`).join('')}
    </div>`;

  let html = basePage();
  html = html.replace('<div class="drawer-mask" id="drawer-mask"></div>', '<div class="drawer-mask show" id="drawer-mask"></div>');
  html = html.replace('<aside class="drawer" id="drawer">', '<aside class="drawer show" id="drawer">');
  html = html.replace('<div class="drawer-body" id="hist-curve"></div>', `<div class="drawer-body" id="hist-curve">${curveHtml}</div>`);
  writeFileSync(path.join(OUT, 'history.html'), html, 'utf-8');
  console.log('✓ docs/shots/history.html');
}
