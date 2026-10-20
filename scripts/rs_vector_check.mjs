// 里德-所罗门标准测试向量：node scripts/rs_vector_check.mjs
// ISO/IEC 18004 附录 I：版本 1-M，"HELLO WORLD" 的纠错码字
import { _internal } from '../app/qrcode.js';

const { rsEncode } = _internal;
const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
const expect = [196, 35, 39, 119, 235, 215, 231, 226, 93, 23];
const got = rsEncode(data, 10);
console.log('期望 EC:', expect.join(' '));
console.log('实际 EC:', got.join(' '));
const ok = JSON.stringify(got) === JSON.stringify(expect);
console.log(ok ? '✓ RS 编码与标准向量一致' : '✗ RS 编码有误');
process.exit(ok ? 0 : 1);
