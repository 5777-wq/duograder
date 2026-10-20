// 最小 QR 码编码器（字节模式 / 纠错等级 M / 版本 1-6）
//
// 为什么自己写：分享卡片要带二维码，而二维码必须在**浏览器本地**生成。
// 走第三方 QR 接口等于把"用户要分享"这件事连同链接发给外部服务，
// 与本项目"数据不出本地"的承诺冲突。顺带也不受对方可用性影响。
//
// 实现参考 ISO/IEC 18004 的经典结构（QR Code Tutorial 系列的标准做法），
// 与参考实现逐模块比对验证过（见 app/test.mjs 的 qr 断言）。
//
// 限制：只支持字节模式（ASCII URL 足够）、只支持纠错等级 M、只支持版本 1-6。
//   版本 7 起需要额外的 18 位版本信息块，收益不大故未实现。
//   M 级可纠正约 15% 损坏，截图分享场景足够。

const ECC_FORMAT_BITS = 0b00;   // M 级在格式信息里的 2 bit 取值
const FORMAT_INFO_MASK = 0x5412;

// 版本表（纠错等级 M）：[每块纠错码字数, 块数, 每块数据码字数, 对齐图案中心坐标]
const VERSIONS = {
  1: { ec: 10, blocks: 1, dataPerBlock: 16, align: [] },
  2: { ec: 16, blocks: 1, dataPerBlock: 28, align: [6, 18] },
  3: { ec: 26, blocks: 1, dataPerBlock: 44, align: [6, 22] },
  4: { ec: 18, blocks: 2, dataPerBlock: 32, align: [6, 26] },
  5: { ec: 24, blocks: 2, dataPerBlock: 43, align: [6, 30] },
  6: { ec: 16, blocks: 4, dataPerBlock: 27, align: [6, 34] },
};
// 字节模式下各版本能装的数据字节数
const CAPACITY = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106 };

/* ---------------- GF(256) 运算 ---------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;      // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

// 生成多项式：∏(x - α^i)，最高次在前
function genPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                    // 乘 x
      next[j + 1] ^= gmul(poly[j], EXP[i]);  // 乘 α^i
    }
    poly = next;
  }
  return poly;
}

// 里德-所罗门：返回纠错码字
function rsEncode(data, ecLen) {
  const gen = genPoly(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], coef);
  }
  return Array.from(res.slice(data.length));
}

/* ---------------- 数据编码 ---------------- */
function encodeData(text, version) {
  const bytes = new TextEncoder().encode(String(text));
  if (bytes.length > CAPACITY[version]) return null;
  const V = VERSIONS[version];
  // 注意两个不同的量：
  //   CAPACITY      = 字节模式能装多少个数据字节（不含模式/计数/填充开销）
  //   blocks×dataPerBlock = 数据码字总个数（模式+计数+数据+填充要装进这么多码字）
  // 早先误用 CAPACITY×8 当总位数，v1-v3（单块）恰好对，v4 起（多块）就短了一半、全部错位。
  const totalCodewords = V.blocks * V.dataPerBlock;
  const totalBits = totalCodewords * 8;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };

  push(0b0100, 4);        // 字节模式
  push(bytes.length, 8);  // 字符计数（版本 1-9 用 8 位）
  for (const b of bytes) push(b, 8);

  for (let i = 0; i < 4 && bits.length < totalBits; i++) bits.push(0);   // 结束符
  while (bits.length % 8 !== 0) bits.push(0);                            // 补到字节边界
  const PAD = [0xec, 0x11];
  let pi = 0;
  while (bits.length < totalBits) push(PAD[pi++ % 2], 8);                // 交替填充码字

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  return out;
}

// 分块 + 计算纠错 + 交织
function buildCodewords(text, version) {
  const V = VERSIONS[version];
  const data = encodeData(text, version);
  if (!data) return null;
  const blocks = [];
  for (let i = 0; i < V.blocks; i++) blocks.push(data.slice(i * V.dataPerBlock, (i + 1) * V.dataPerBlock));
  const ecBlocks = blocks.map((b) => rsEncode(b, V.ec));
  const out = [];
  for (let i = 0; i < V.dataPerBlock; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < V.ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

/* ---------------- 矩阵构建 ---------------- */
function blankMatrix(version) {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  return { size, modules, isFunction };
}

function placeFunctionPatterns(q, version) {
  const { size, modules, isFunction } = q;
  const setFn = (r, c, v) => { modules[r][c] = v; isFunction[r][c] = true; };

  // 三个定位图案（含分隔符）
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const ring = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFn(r, c, ring || core);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // 校正图案
  const centers = VERSIONS[version].align;
  for (const r of centers) {
    for (const c of centers) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFn(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // 格式信息占位（真正的值在选完掩码后写）
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { setFn(8, i, false); setFn(i, 8, false); }
  }
  for (let i = 0; i < 8; i++) { setFn(8, size - 1 - i, false); setFn(size - 1 - i, 8, false); }
  // 固定的暗模块
  setFn(size - 8, 8, true);
}

// 数据码字按之字形填入
function placeCodewords(q, codewords) {
  const { size, modules, isFunction } = q;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

/* ---------------- 掩码 ---------------- */
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(q, mask) {
  const { size, modules, isFunction } = q;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

/* ---------------- 罚分（选最优掩码） ---------------- */
const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

function penalty(q) {
  const { size, modules } = q;
  let result = 0;

  const countPatterns = (h) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const addHistory = (len, h) => {
    if (h[0] === 0) len += size;      // 起始处补一圈浅色边
    h.pop();
    h.unshift(len);
  };
  const terminate = (color, len, h) => {
    if (color) { addHistory(len, h); len = 0; }
    len += size;                        // 结尾补一圈浅色边
    addHistory(len, h);
    return countPatterns(h);
  };

  for (let y = 0; y < size; y++) {
    let runColor = false, runLen = 0;
    const hist = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        addHistory(runLen, hist);
        if (!runColor) result += countPatterns(hist) * PENALTY_N3;
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += terminate(runColor, runLen, hist) * PENALTY_N3;
  }
  for (let x = 0; x < size; x++) {
    let runColor = false, runLen = 0;
    const hist = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        addHistory(runLen, hist);
        if (!runColor) result += countPatterns(hist) * PENALTY_N3;
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += terminate(runColor, runLen, hist) * PENALTY_N3;
  }
  // 2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += PENALTY_N2;
    }
  }
  // 深浅比例
  let dark = 0;
  for (const row of modules) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

/* ---------------- 格式信息 ---------------- */
function formatInfoBits(mask) {
  const data = (ECC_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ FORMAT_INFO_MASK;
  // LSB 优先：放置时按位号 0..14 取值（格式信息里 bit 0 是最低位）
  const out = [];
  for (let i = 0; i < 15; i++) out.push((bits >>> i) & 1);
  return out;
}

function placeFormatInfo(q, mask) {
  const { size, modules, isFunction } = q;
  const bits = formatInfoBits(mask);
  // 一律写布尔值：整个矩阵必须是同一种类型，否则外部按 !== 比较时会把 1/0 与 true/false 判成不同
  const setFn = (r, c, v) => { modules[r][c] = !!v; isFunction[r][c] = true; };
  // 第一份：左上角，围绕定位图案（行 8 / 列 8）
  for (let i = 0; i <= 5; i++) setFn(i, 8, bits[i]);
  setFn(7, 8, bits[6]);
  setFn(8, 8, bits[7]);
  setFn(8, 7, bits[8]);
  for (let i = 9; i < 15; i++) setFn(8, 14 - i, bits[i]);
  // 第二份：右下角 / 左下角，围绕另外两个定位图案
  for (let i = 0; i < 8; i++) setFn(8, size - 1 - i, bits[i]);
  for (let i = 8; i < 15; i++) setFn(size - 15 + i, 8, bits[i]);
  // 固定的暗模块
  setFn(size - 8, 8, true);
}

/* ---------------- 对外接口 ---------------- */

/**
 * 生成 QR 矩阵。
 * @param {string} text 要编码的内容（ASCII URL 最佳）
 * @returns {{size:number, modules:boolean[][]}|null} null 表示内容太长装不下
 */
export function qrMatrix(text, forceMask = -1) {
  const s = String(text ?? '');
  if (!s) return null;
  for (let version = 1; version <= 6; version++) {
    const codewords = buildCodewords(s, version);
    if (!codewords) continue;

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      if (forceMask >= 0 && mask !== forceMask) continue;
      const q = blankMatrix(version);
      placeFunctionPatterns(q, version);
      placeCodewords(q, codewords);
      applyMask(q, mask);
      placeFormatInfo(q, mask);
      const score = penalty(q);
      if (!best || score < best.score) best = { score, q, mask };
    }
    return { size: best.q.size, modules: best.q.modules, mask: best.mask, version };
  }
  return null;   // 超过版本 6 的容量（106 字节）
}

/** 把矩阵渲染成方形字符串（'#' = 深色），用于调试与测试比对 */
export function qrToAscii(text) {
  const m = qrMatrix(text);
  if (!m) return null;
  return m.modules.map((row) => row.map((c) => (c ? '#' : '.')).join('')).join('\n');
}

// 内部函数导出，仅供测试与校验脚本使用
export const _internal = { rsEncode, buildCodewords, encodeData, genPoly, gmul, penalty, placeFormatInfo, formatInfoBits };
