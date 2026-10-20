// 跨实现一致性断言：node app/parity.mjs
//
// 仓库多处声称"与 scripts/*.py 同口径"。这轮修掉的三处分叉（维度比较、
// consistency.dimension_sum、必填字段、句首小写计数、机械问题文案）就是没被断言出来的。
// 这里把"同口径"变成 CI 里可执行的断言：同一份输入，JS 与 Python 必须给出同样结论。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { precheck, validateReport, mergeSameBand } from './core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(ROOT, 'skill', 'kaoyan-essay');
const FIX = path.join(SKILL, 'tests', 'fixtures');

let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : `\n      差异: ${extra}`));
  if (!cond) failed++;
};

function py(args) {
  // 强制子进程用 UTF-8 输出：Windows 下 Python 默认 GBK，跨进程读 JSON 会乱码
  return execFileSync('python', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
}

const CASES = [
  ['essay-synthetic-flawed.txt', 'english-ii', 'large'],
  ['essay-synthetic-flawed.txt', 'english-ii', 'small'],
  ['essay-synthetic-good.txt', 'english-i', 'large'],
  ['essay-synthetic-good.txt', 'english-i', 'small'],
  ['essay-synthetic-weak.txt', 'english-ii', 'large'],
  ['essay-synthetic-weak.txt', 'english-ii', 'small'],
  ['essay-synthetic-small.txt', 'english-ii', 'small'],
  ['essay-synthetic-en1-large.txt', 'english-i', 'large'],
  ['essay-real-shanbay-compare.txt', 'english-ii', 'large'],
];

console.log('预检事实清单：JS 与 Python 必须逐字段一致');
for (const [file, track, task] of CASES) {
  const essay = readFileSync(path.join(FIX, file), 'utf-8');
  const pyOut = JSON.parse(py([path.join(SKILL, 'scripts', 'precheck.py'), path.join(FIX, file), '--track', track, '--task', task]));
  delete pyOut.prompt_file; // Python 独有字段
  const jsOut = precheck(essay, track, task);
  const a = JSON.stringify(pyOut), b = JSON.stringify(jsOut);
  ok(`precheck 一致：${file} ${track}/${task}`, a === b, `\n  py: ${a}\n  js: ${b}`);
}

console.log('报告校验：JS 与 Python 必须给出同样的失败项数');
{
  const essayFile = path.join(FIX, 'essay-synthetic-flawed.txt');
  const essay = readFileSync(essayFile, 'utf-8');
  const vdir = path.join(ROOT, 'docs', 'validation', '2026-10-08');

  const reports = ['graderA.json', 'graderB.json', 'goodA.json', 'goodB.json', 'weakA.json', 'weakB.json'];
  for (const rname of reports) {
    const rpath = path.join(vdir, rname);
    if (!readFileSync(rpath, 'utf-8')) continue;
    const report = JSON.parse(readFileSync(rpath, 'utf-8'));
    let pyCode = 0, pyOut = '';
    try {
      pyOut = py([path.join(SKILL, 'scripts', 'validate_report.py'), rpath, essayFile]);
    } catch (e) {
      pyCode = e.status ?? 1;
      pyOut = (e.stdout || '') + (e.stderr || '');
    }
    const pyFails = (pyOut.match(/^\[失败\]/gm) || []).length;
    const jsFails = validateReport(report, essay).failures.length;
    ok(`校验结论一致：${rname}（py 失败 ${pyFails} / js 失败 ${jsFails}）`, pyFails === jsFails, pyOut);
  }
}

console.log('同档合并：JS 与 Python 必须给出同样的终裁分与同样的退出语义');
{
  const vdir = path.join(ROOT, 'docs', 'validation', '2026-10-08');
  const load = (n) => JSON.parse(readFileSync(path.join(vdir, n), 'utf-8'));
  const pairs = [['graderA.json', 'graderB.json'], ['goodA.json', 'goodB.json'], ['weakA.json', 'weakB.json']];
  for (const [an, bn] of pairs) {
    const A = load(an), B = load(bn);
    let pyCode = 0, pyOut = '';
    try {
      pyOut = py([path.join(SKILL, 'scripts', 'average_reports.py'), path.join(vdir, an), path.join(vdir, bn)]);
    } catch (e) {
      pyCode = e.status ?? 1;
      pyOut = (e.stdout || '') + (e.stderr || '');
    }
    const m = mergeSameBand(A, B);
    if (pyCode === 0) {
      const pyTotal = Number((pyOut.match(/终裁: 第\d档 ([\d.]+) 分/) || [])[1]);
      ok(`合并终裁分一致：${an}+${bn}`, m.ok && m.final.final_score === pyTotal, `py=${pyTotal} js=${m.ok ? m.final.final_score : 'n/a'}`);
    } else {
      // Python exit 2 = 需仲裁；exit 3 = 打回重评。JS 的 reason 必须能一一对应
      const expect = pyCode === 2 ? ['arbiter', 'out_of_band'] : ['dimension_names'];
      ok(`合并退出语义一致：${an}+${bn}（py exit ${pyCode}）`, expect.includes(m.reason), `js reason=${m.reason}`);
    }
  }
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过（JS 与 Python 同口径）');
process.exit(failed ? 1 : 0);
