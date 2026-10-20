// QR 编码器跨实现校验：node scripts/verify_qr.mjs
//
// 需要参考实现（仅开发期用，CI 不依赖）：
//   npm install qrcode jsqr --no-save
//
// 做两件事：
//   1) 与参考实现逐模块比对（掩码相同则应完全一致；不同则只是选了另一个合法掩码）
//   2) 用 jsQR 解码自研生成的矩阵——能被扫出来才算数
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const { qrMatrix } = await import('../app/qrcode.js');

const CASES = [
  'https://duograder.pages.dev/app/',
  'https://duograder.pages.dev/app',
  'https://duograder.pages.dev/',
  'https://github.com/5777-wq/duograder',
  'http://127.0.0.1:8731/app/',
  'https://a.cn',
  'https://kaoyan-sheets.pages.dev/',
  'https://duograder.pages.dev/app/?from=qr&utm_source=card',
  'x'.repeat(80),
  'https://example.com/' + 'a'.repeat(60),
];

let bad = 0;
for (const text of CASES) {
  const mine = qrMatrix(text);
  const ref = QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'M' });
  const size = ref.modules.size;
  let diff = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const refDark = ref.modules.data[y * size + x] === 1;
      if (!!mine.modules[y][x] !== refDark) diff++;
    }
  }
  // 解码自研矩阵
  const scale = 6, pad = 4 * scale;
  const w = mine.size * scale + pad * 2;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < mine.size; y++) {
    for (let x = 0; x < mine.size; x++) {
      if (!mine.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((pad + y * scale + dy) * w + (pad + x * scale + dx)) * 4;
          px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 255;
        }
      }
    }
  }
  const res = jsQR(px, w, w);
  const decoded = res && res.data === text;
  if (!decoded) bad++;
  console.log(`${decoded ? '✓' : '✗'} ${JSON.stringify(text.slice(0, 44))} → ${decoded ? '解码成功' : '解码失败'}；与参考实现差 ${diff} 模块（掩码不同就会有差异，同为合法 QR）`);
}
console.log(bad ? `\n${bad} 个用例无法解码` : '\n全部可被扫描器正确解码');
process.exit(bad ? 1 : 0);
