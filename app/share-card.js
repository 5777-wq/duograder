// 分享卡片：Canvas 本地绘制 + 本地二维码
//
// 为什么全部在浏览器里做：作文内容、分数、Key 都不该为了"生成分享图"发到服务器。
// 二维码也是本地编码的（见 qrcode.js），不走任何第三方接口。
//
// 视觉沿用应用的瑞士国际主义：纸白底、纯黑网格、单一瑞士红强调、hairline 分隔、
// 圆角 0、无渐变无投影。大分数是主角，汇聚尺是签名，二维码在底部承接宣传。
import { qrMatrix } from './qrcode.js';

const INK = '#111111';
const PAPER = '#f7f6f2';
const SURFACE = '#ffffff';
const MUTED = '#75756e';
const HAIRLINE = '#deddd5';
const ACCENT = '#e30613';
const BORDER = '#c9c8c0';

const SANS = '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SERIF = 'Georgia, "Songti SC", serif';

/** 组装绘制所需的数据（从终裁报告里取） */
export function shareCardData(final, facts, opts = {}) {
  const track = final?.report_a?.meta?.exam_track || opts.track || 'english-ii';
  const task = final?.report_a?.meta?.task || opts.task || 'large';
  const max = ({ 'english-i_large': 20, 'english-ii_large': 15, 'english-i_small': 10, 'english-ii_small': 10 })[`${track}_${task}`] || 15;
  const [ia, ib] = final?.initial || [];
  const rep = final?.decision === 'pick_b' ? final?.report_b : final?.report_a;
  const same = final?.decision === 'same_band';
  return {
    score: Number(final?.final_score ?? 0),
    max,
    band: final?.final_band ?? '-',
    range: (final?.final_range || []).join('-'),
    trackLabel: ({ 'english-i': '英语一', 'english-ii': '英语二' })[track] || track,
    taskLabel: task === 'small' ? '小作文 Part A' : '大作文 Part B',
    words: facts?.word_count ?? null,
    a: Number(ia?.score ?? 0),
    b: Number(ib?.score ?? 0),
    sameBand: same,
    mech: same ? '双评一致 · 脚本合并' : `差档 · 仲裁${final?.decision === 'pick_a' ? '采 A' : final?.decision === 'pick_b' ? '采 B' : ''}`,
    problems: (rep?.top_problems || []).slice(0, 2),
    url: opts.url || 'https://duograder.pages.dev/app/',
    site: opts.site || 'duograder.pages.dev',
    model: final?.report_a?.meta?.grader_model || '',
  };
}

/* ---------- 绘制小工具 ---------- */
function hairline(ctx, x1, y, x2, color = HAIRLINE, w = 2) {
  ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
}
function fillText(ctx, text, x, y, { font, color = INK, align = 'left', maxWidth } = {}) {
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  if (!maxWidth) { ctx.fillText(text, x, y); return; }
  // 中文按字断行（英文单词不拆）
  let line = '', out = [];
  const isCJK = (c) => /[⺀-鿿＀-￯]/.test(c);
  const tokens = [];
  let buf = '';
  for (const c of String(text)) {
    if (isCJK(c) || c === ' ') { if (buf) { tokens.push(buf); buf = ''; } tokens.push(c); }
    else buf += c;
  }
  if (buf) tokens.push(buf);
  for (const t of tokens) {
    const test = line + t;
    if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = t.trimStart(); }
    else line = test;
  }
  if (line) out.push(line);
  out.forEach((l, i) => ctx.fillText(l, x, y + i * (parseInt(font.match(/(\d+)px/)?.[1] || '14', 10) * 1.55)));
  return out.length;
}

// 汇聚尺（卡片上的签名元素，与应用里的那把尺子同构）
function drawRail(ctx, d, x, y, w) {
  const rows = [
    { label: '阅卷员 A', v: d.a },
    { label: '阅卷员 B', v: d.b },
    { label: '终裁', v: d.score, final: true },
  ];
  const rowH = 54;
  rows.forEach((r, i) => {
    const yy = y + i * rowH;
    ctx.fillStyle = r.final ? INK : MUTED;
    ctx.font = `500 22px ${SANS}`;
    ctx.textAlign = 'right';
    ctx.fillText(r.label, x - 24, yy + 8);
    // 底尺
    ctx.strokeStyle = BORDER; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
    // 走到分数位置
    const ratio = Math.max(0, Math.min(1, r.v / d.max));
    const px = x + w * ratio;
    ctx.strokeStyle = r.final ? ACCENT : INK; ctx.lineWidth = r.final ? 4 : 3;
    ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(px, yy); ctx.stroke();
    // 刻点方块
    ctx.fillStyle = r.final ? ACCENT : INK;
    const s = r.final ? 16 : 13;
    ctx.fillRect(px - s / 2, yy - s / 2, s, s);
    // 分数
    ctx.fillStyle = r.final ? ACCENT : INK;
    ctx.font = `700 ${r.final ? 26 : 22}px ${SANS}`;
    ctx.textAlign = 'left';
    ctx.fillText(String(r.v), x + w + 24, yy + 8);
  });
}

// 二维码
function drawQR(ctx, text, x, y, size) {
  const m = qrMatrix(text);
  if (!m) return 0;
  const quiet = 4;
  const total = m.size + quiet * 2;
  const cell = size / total;
  ctx.fillStyle = SURFACE;
  ctx.fillRect(x, y, size, size);
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.modules[r][c]) continue;
      ctx.fillStyle = INK;
      ctx.fillRect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell + 0.6, cell + 0.6);
    }
  }
  return size;
}

/**
 * 绘制分享卡片。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W 画布宽
 * @param {number} H 画布高
 * @param {object} data shareCardData() 的产物
 */
export function drawShareCard(ctx, W, H, d) {
  const PAD = 72;
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  /* 页眉 */
  ctx.fillStyle = ACCENT;
  ctx.fillRect(PAD, 62, 10, 46);
  ctx.fillStyle = INK;
  ctx.font = `700 40px ${SANS}`;
  ctx.textAlign = 'left';
  ctx.fillText('DuoGrader', PAD + 26, 98);
  ctx.fillStyle = MUTED;
  ctx.font = `500 24px ${SANS}`;
  ctx.fillText('双评阅卷官 · 考研英语作文', PAD + 26, 128);
  ctx.textAlign = 'right';
  ctx.fillStyle = MUTED;
  ctx.font = `500 22px ${SANS}`;
  ctx.fillText(d.site, W - PAD, 98);
  hairline(ctx, PAD, 148, W - PAD, INK, 3);

  /* 分数区 */
  let y = 236;
  ctx.textAlign = 'left';
  ctx.fillStyle = MUTED;
  ctx.font = `500 26px ${SANS}`;
  ctx.fillText(`${d.trackLabel} · ${d.taskLabel}`, PAD, y);

  y += 40;
  ctx.fillStyle = ACCENT;
  ctx.font = `700 190px ${SANS}`;
  ctx.fillText(String(d.score), PAD - 8, y + 150);
  const scoreW = ctx.measureText(String(d.score)).width;
  ctx.fillStyle = MUTED;
  ctx.font = `500 46px ${SANS}`;
  ctx.fillText(`/ ${d.max}`, PAD + scoreW + 6, y + 150);

  ctx.fillStyle = INK;
  ctx.font = `700 34px ${SANS}`;
  ctx.fillText(`第 ${d.band} 档（${d.range}）`, PAD, y + 208);
  ctx.fillStyle = MUTED;
  ctx.font = `500 24px ${SANS}`;
  const meta = [d.words ? `${d.words} 词` : null, d.mech].filter(Boolean).join('  ·  ');
  ctx.fillText(meta, PAD, y + 248);
  y += 286;

  /* 汇聚尺 */
  ctx.fillStyle = INK;
  ctx.font = `700 24px ${SANS}`;
  ctx.fillText('双评过程', PAD, y);
  drawRail(ctx, d, PAD + 150, y + 36, W - PAD * 2 - 150 - 90);
  y += 36 + 54 * 3 + 44;

  /* 最限制得分的问题 */
  if (d.problems.length) {
    hairline(ctx, PAD, y - 26, W - PAD, HAIRLINE, 2);
    ctx.fillStyle = INK;
    ctx.font = `700 24px ${SANS}`;
    ctx.fillText('最限制得分的问题', PAD, y);
    y += 40;
    for (const p of d.problems) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(PAD, y - 15, 6, 6);
      ctx.fillStyle = INK;
      ctx.font = `500 25px ${SANS}`;
      const lines = fillText(ctx, p, PAD + 20, y, { font: `500 25px ${SANS}`, color: INK, maxWidth: W - PAD * 2 - 20 });
      y += 25 * 1.55 * lines + 10;
    }
  }

  /* 底部：二维码 + 宣传 */
  // 二维码别太小：分享图在手机上会被缩放，格子太细会扫不出来
  const qrSize = 196;
  const qrY = H - PAD - qrSize;
  hairline(ctx, PAD, qrY - 40, W - PAD, INK, 3);
  drawQR(ctx, d.url, PAD, qrY, qrSize);
  ctx.strokeStyle = BORDER; ctx.lineWidth = 2;
  ctx.strokeRect(PAD, qrY, qrSize, qrSize);

  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `700 30px ${SANS}`;
  ctx.fillText('扫码免费批改', PAD + qrSize + 36, qrY + 46);
  ctx.fillStyle = MUTED;
  ctx.font = `500 24px ${SANS}`;
  ctx.fillText('每 IP 赠 50 次 · 不用配置 API', PAD + qrSize + 36, qrY + 86);
  ctx.fillStyle = INK;
  ctx.font = `500 24px ${SANS}`;
  ctx.fillText(d.site + '/app', PAD + qrSize + 36, qrY + 126);
  if (d.model) {
    ctx.fillStyle = MUTED;
    ctx.font = `400 19px ${SANS}`;
    ctx.fillText('阅卷模型 ' + d.model, PAD + qrSize + 36, qrY + 156);
  }
  ctx.restore();
}

/** 生成可直接下载/分享的 PNG Blob */
export async function makeShareCard(final, facts, opts = {}) {
  const W = 1080, H = 1440;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  drawShareCard(ctx, W, H, shareCardData(final, facts, opts));
  return new Promise((resolve) => canvas.toBlob((b) => resolve({ blob: b, canvas }), 'image/png'));
}
