// core.js 回归测试：与 Python 脚本同口径（node test.mjs）
import { readFileSync } from 'node:fs';
import { countWords, precheck, snapHalfDown, parseModelJSON, validateReport, mergeSameBand, detectTaskType, transcriptionMessages } from './core.js';

let failed = 0;
const ok = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; };

console.log('字数统计（对齐 precheck.py 实测值）');
const fx = (f) => readFileSync(new URL('../skill/kaoyan-essay/tests/fixtures/' + f, import.meta.url), 'utf-8');
const vdir = new URL('../docs/validation/2026-10-08/', import.meta.url);
ok('flawed = 135 词', countWords(fx('essay-synthetic-flawed.txt')) === 135);
ok('good = 149 词', countWords(fx('essay-synthetic-good.txt')) === 149);
ok('weak = 83 词', countWords(fx('essay-synthetic-weak.txt')) === 83);
ok("don't / well-known / 84.8% 各算一词", countWords("don't well-known 84.8% a") === 4);

console.log('预检');
const pf = precheck(fx('essay-synthetic-flawed.txt'), 'english-ii', 'large');
ok('段落 3 / blank_line', pf.paragraph_count === 3 && pf.paragraph_basis === 'blank_line');
ok('length_status soft_ok（0.9）', pf.length_status === 'soft_ok');
ok('抓到 the the 重复词', pf.mechanical_flags.some((f) => f.type === 'repeated_word'));
const pw = precheck(fx('essay-synthetic-weak.txt'), 'english-ii', 'large');
ok('weak short_two_thirds', pw.length_status === 'short_two_thirds');

console.log('取整收敛');
ok('8.5 保持 8.5', snapHalfDown(8.5) === 8.5);
ok('8.75 收敛 8.5（尾数从严）', snapHalfDown(8.75) === 8.5);
ok('8.25 收敛 8.0', snapHalfDown(8.25) === 8);

console.log('模型 JSON 容错解析');
const bad = '{"a":[{"x":1}{"x":2}]}';
ok('数组漏逗号自动修复', parseModelJSON(bad).ok === true && parseModelJSON(bad).obj.a.length === 2);
ok('剥围栏', parseModelJSON('```json\n{"a":1}\n```').ok === true);
ok('带前后杂质的 JSON', parseModelJSON('报告如下：\n{"a":1}\n以上。').ok === true);
ok('真坏 JSON 报错', parseModelJSON('not json at all').ok === false);
// 生产事故回归：JSON 后跟含大括号的注释文字（真机阅卷员 B 实际失败模式）
const trailing = '{"a":{"b":1}} 注：以上 JSON 中 {"x":1} 为示例，请忽略。';
ok('JSON 后跟含大括号注释可解析', parseModelJSON(trailing).ok === true && parseModelJSON(trailing).obj.a.b === 1);

console.log('报告校验（用已入库的空跑真实报告回归）');
const rA = JSON.parse(readFileSync(new URL('graderA.json', vdir), 'utf-8'));
const rB = JSON.parse(readFileSync(new URL('graderB.json', vdir), 'utf-8'));
const vA = validateReport(rA, fx('essay-synthetic-flawed.txt'));
ok('graderA 通过', vA.failures.length === 0);
const badMeta = JSON.parse(JSON.stringify(rA)); badMeta.meta.max_score = 20;
ok('英二按20分制被打回', validateReport(badMeta, fx('essay-synthetic-flawed.txt')).failures.some((f) => f.includes('组合非法')));

console.log('同档合并（对齐 average_reports.py 实测 8.5）');
const m = mergeSameBand(rA, rB);
ok('合并成功且终裁 8.5 第三档', m.ok === true && m.final.final_score === 8.5 && m.final.final_band === 3);
const wA = JSON.parse(readFileSync(new URL('weakA.json', vdir), 'utf-8'));
const wB = JSON.parse(readFileSync(new URL('weakB.json', vdir), 'utf-8'));
ok('档位不一致正确转仲裁', mergeSameBand(wA, wB).reason === 'arbiter');

console.log('题型/科目自动识别');
ok('英二大作文（150词/15分）', detectTaskType('Write an essay based on the chart below. Write your answer in about 150 words on the ANSWER SHEET. (15 points)').task === 'large' && detectTaskType('Write an essay based on the chart below. Write your answer in about 150 words. (15 points)').track === 'english-ii');
ok('英一大作文（160-200词/20分）', detectTaskType('Write an essay of 160-200 words based on the picture below. (20 points)').task === 'large' && detectTaskType('Write an essay of 160-200 words based on the picture below. (20 points)').track === 'english-i');
ok('小作文（约100词/10分）', detectTaskType('Write him an email. Write your answer in about 100 words. (10 points)').task === 'small');
ok('书信关键词兜底', detectTaskType('Suppose you and Jack are going to do a survey. Write him an email to put forward your plan.').task === 'small');
ok('图表关键词兜底→英二', detectTaskType('Write an essay based on the chart below. describe and interpret the chart.').task === 'large' && detectTaskType('Write an essay based on the chart below.').track === 'english-ii');
ok('整页含PartA+B→按大作文并提示', (() => { const d = detectTaskType('Part A ... about 100 words ... (10 points) Part B ... about 150 words ... (15 points)'); return d.task === 'large' && d.evidence[0].includes('点改'); })());
ok('无线索→不乱猜', detectTaskType('hello world').task === null);

console.log('级别中文与反模板（内核 v1.4）');
const zh = JSON.parse(JSON.stringify(rA));
const SEV_ZH = { error: '错误', awkward: '欠佳', style: '润色' };
zh.sentence_edits.forEach((e) => { e.severity = SEV_ZH[e.severity] || e.severity; });
ok('中文级别（错误/欠佳/润色）通过校验', validateReport(zh, fx('essay-synthetic-flawed.txt')).failures.length === 0);
ok('旧英文级别仍兼容', validateReport(rA, fx('essay-synthetic-flawed.txt')).failures.length === 0);
const bl = JSON.parse(JSON.stringify(rA));
bl.reusable = { patterns: ['warm and happy', 'I would appreciate it if you could ...'] };
ok('可复用套话黑名单被打回', validateReport(bl, fx('essay-synthetic-flawed.txt')).failures.some((f) => f.includes('warm and happy')));
const badSev = JSON.parse(JSON.stringify(rA));
badSev.sentence_edits[0].severity = 'typo';
ok('非法 severity 打回', validateReport(badSev, fx('essay-synthetic-flawed.txt')).failures.some((f) => f.includes('severity 非法')));

console.log('转写协议（科目自动识别）');
ok('combined 模式带 track_guess/task_guess/evidence 字段', (() => {
  const msg = JSON.stringify(transcriptionMessages([], 'combined'));
  return msg.includes('track_guess') && msg.includes('task_guess') && msg.includes('evidence') && msg.includes('真题');
})());

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
