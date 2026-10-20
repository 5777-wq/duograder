// 生成 QR 回归 fixture：node scripts/gen_qr_fixtures.mjs
// 这份 fixture 由自研编码器产出，作用是**锁住实现**——改了编码器而没同步 fixture，CI 会红。
// 独立锚点不靠它：
//   · 里德-所罗门用 ISO/IEC 18004 的标准测试向量
//   · 格式信息用已发表的 (纠错等级, 掩码) 常量
//   · 跨实现比对与"能否被扫描器解码"见 scripts/verify_qr.mjs（需要 npm qrcode / jsqr）
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrMatrix } from '../app/qrcode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CASES = [
  'https://duograder.pages.dev/app/',
  'https://duograder.pages.dev/',
  'https://github.com/5777-wq/duograder',
  'http://127.0.0.1:8731/app/',
  'https://a.cn',
  'https://kaoyan-sheets.pages.dev/',
  'https://example.com/' + 'a'.repeat(60),
  'x'.repeat(80),
  'https://duograder.pages.dev/app/?from=qr&utm_source=card',
];

const out = [];
for (const text of CASES) {
  const m = qrMatrix(text);
  if (!m) { console.log(`✗ ${text} 生成失败`); process.exit(1); }
  const rows = m.modules.map((r) => r.map((v) => (v ? '#' : '.')).join(''));
  out.push({ text, size: m.size, mask: m.mask, rows });
  console.log(`✓ ${JSON.stringify(text.slice(0, 40))} ${m.size}×${m.size} mask=${m.mask}`);
}

mkdirSync(path.join(ROOT, 'app', 'fixtures'), { recursive: true });
writeFileSync(path.join(ROOT, 'app', 'fixtures', 'qr-cases.json'), JSON.stringify(out, null, 1), 'utf-8');
console.log(`\n已写入 app/fixtures/qr-cases.json（${out.length} 个用例）`);
