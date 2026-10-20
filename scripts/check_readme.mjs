// README 自检：node scripts/check_readme.mjs
// 目的：README 里写的每个本地路径、每个目录锚点、每个断言数都必须与仓库现状一致。
// 文档漂移比代码漂移更难发现——所以把它变成 CI 里可执行的断言。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(path.join(ROOT, 'README.md'), 'utf-8');

let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : `  → ${extra}`));
  if (!cond) failed++;
};

/* 1) 本地路径链接必须真实存在 */
console.log('本地路径链接');
const links = [...md.matchAll(/\]\(([^)#][^)]*)\)/g)].map((m) => m[1]);
const local = [...new Set(links.filter((l) => !/^https?:|^mailto:/.test(l)))];
for (const l of local) {
  const p = path.join(ROOT, l.split('#')[0]);
  ok(l, existsSync(p), '不存在');
}

/* 2) 关键资产不能被 README 漏掉 */
console.log('关键资产是否被提及');
const mustMention = [
  'app/core.js', 'app/ui.js', 'app/style.css', 'app/sw.js',
  'app/electron-main.cjs', 'app/static-server.cjs',
  'app/test.mjs', 'app/parity.mjs', 'app/static-server.test.mjs',
  'proxy/proxy-core.js', 'functions/v1/', 'workers/invite-proxy/',
  'scripts/sync_app.py',
  'skill/kaoyan-essay/SKILL.md', 'skill/kaoyan-essay/rubrics/writing-rubric.md',
  'skill/kaoyan-essay/schema/grading-report.schema.json',
  'skill/kaoyan-essay/prompts/', 'skill/kaoyan-essay/references/past-prompts-index.md',
  'skill/kaoyan-essay/scripts/', 'skill/kaoyan-essay/tests/fixtures/',
  'docs/validation/', 'docs/assets/logo.svg', 'docs/assets/report-preview.png',
];
for (const m of mustMention) ok(`提到 ${m}`, md.includes(m));

/* 3) 目录锚点必须与标题对得上
   GitHub 锚点规则：小写 → 去 emoji 与标点（含全角）→ 空格转连字符 */
console.log('目录锚点');
const headings = [...md.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim());
const slug = (h) => h
  .toLowerCase()
  .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')   // emoji
  .replace(/[\p{P}\p{S}]/gu, '')                                    // 全部 Unicode 标点与符号（含全角）
  .replace(/\s+/g, '-');
const slugs = new Set(headings.map(slug));
for (const m of md.matchAll(/\]\(#([^)]+)\)/g)) {
  ok(`锚点 #${m[1]}`, slugs.has(m[1]), `候选: ${[...slugs].join(' / ')}`);
}

/* 4) 断言数：直接跑各测试文件数 ✓，而不是数源码里的 ok( —— 那是真值 */
console.log('断言数与实际一致');
const SUITES = [
  ['app/test.mjs', 'node app/test.mjs'],
  ['proxy/proxy-core.test.mjs', 'node proxy/proxy-core.test.mjs'],
  ['app/parity.mjs', 'node app/parity.mjs'],
  ['app/static-server.test.mjs', 'node app/static-server.test.mjs'],
];
let total = 0;
for (const [file, cmd] of SUITES) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, encoding: 'utf-8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const n = (out.match(/✓/g) || []).length;
  total += n;
  ok(`${file} 实际 ${n} 条断言，README 写的也是 ${n}`, md.includes(`\`${cmd}\` | ${n} |`), 'README 里的数字对不上');
}
ok(`总断言数 ${total}，README 一致`, md.includes(`${total} 项断言`), `README 里写的不是 ${total}`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
