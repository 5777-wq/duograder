// core.js 回归测试：与 Python 脚本同口径（node test.mjs）
import { readFileSync } from 'node:fs';
import { countWords, precheck, snapHalfDown, parseModelJSON, validateReport, mergeSameBand, detectTaskType, transcriptionMessages, shouldSendDeviceId, dualRail, detectProviderByKey, keyLooksMismatched } from './core.js';

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

console.log('转写协议（科目自动识别 + 手写修改痕迹）');
ok('combined 模式带 track_guess/task_guess/evidence/crossed_out 字段', (() => {
  const msg = JSON.stringify(transcriptionMessages([], 'combined'));
  return msg.includes('track_guess') && msg.includes('task_guess') && msg.includes('evidence')
    && msg.includes('crossed_out') && msg.includes('真题') && msg.includes('划掉');
})());
ok('essay 模式带划线/旁注规则', (() => {
  const msg = JSON.stringify(transcriptionMessages([], 'essay'));
  return msg.includes('划掉') && msg.includes('旁注') && msg.includes('保留');
})());

console.log('合并失败按 reason 分流（维度顺序不同不再被误判成"不一致"）');
const shuffled = JSON.parse(JSON.stringify(rA));
shuffled.scores.dimensions.reverse();
ok('维度顺序不同（集合相同）仍可确定性合并', mergeSameBand(rA, shuffled).ok === true);
const diffDims = JSON.parse(JSON.stringify(rA));
diffDims.scores.dimensions[0].name = '完全不同的维度名';
const md = mergeSameBand(rA, diffDims);
ok('维度集合不一致 → dimension_names（应打回重评，不进仲裁）', md.ok === false && md.reason === 'dimension_names');
ok('dimension_names 带差异明细', Array.isArray(md.detail?.only_a) && md.detail.only_a.length === 1);

console.log('报告校验补齐（与 validate_report.py 同口径）');
const noSum = JSON.parse(JSON.stringify(rA));
noSum.consistency.dimension_sum = 99;
ok('consistency.dimension_sum 不符被打回', validateReport(noSum, fx('essay-synthetic-flawed.txt')).failures.some((f) => f.includes('dimension_sum')));
const noField = JSON.parse(JSON.stringify(rA));
delete noField.improved_version;
ok('缺必填字段 improved_version 被打回', validateReport(noField, fx('essay-synthetic-flawed.txt')).failures.some((f) => f.includes('improved_version')));
const noEdits = JSON.parse(JSON.stringify(rA));
delete noEdits.sentence_edits;
ok('缺必填字段 sentence_edits 被打回', validateReport(noEdits, fx('essay-synthetic-flawed.txt')).failures.some((f) => f.includes('sentence_edits')));
const boolWc = JSON.parse(JSON.stringify(rA));
boolWc.meta.word_count_reported = true;
ok('word_count_reported 非整数被打回', validateReport(boolWc, fx('essay-synthetic-flawed.txt')).failures.some((f) => f.includes('word_count_reported')));

console.log('预检计数与 Python 同口径');
const manyLower = 'this is a test. another line here. third one. fourth. fifth. sixth.';
const ml = precheck(manyLower, 'english-ii', 'large').mechanical_flags.find((f) => f.type === 'lowercase_sentence_start');
ok('句首小写计数不被 3 条截断', !!ml && ml.count === 6);

console.log('设备指纹只发往内置算力通道');
ok('invite 预设才带设备头', shouldSendDeviceId({ preset: 'invite' }) === true);
ok('自带 Key 的供应商不带设备头', shouldSendDeviceId({ preset: 'deepseek' }) === false);
ok('无 preset 不带设备头', shouldSendDeviceId({}) === false);
ok('undefined 不带设备头', shouldSendDeviceId(undefined) === false);

console.log('双评汇聚尺（报告头签名元素）');
{
  const same = dualRail({ decision: 'same_band', final_score: 8.5, band_gap: 0 }, 15, { score: 8.5 }, { score: 8.5 });
  ok('同档：A/B/终裁 三行刻度比例一致（刻点垂直对齐）', (same.match(/--ratio:0\.5667/g) || []).length === 6);
  ok('同档：机制文案为脚本确定性合并', same.includes('同档 · 脚本确定性合并'));
  ok('同档：含 A/B/终裁 三行，终裁行带 dr-final', same.includes('阅卷员 A') && same.includes('阅卷员 B') && same.includes('dr-final'));
  ok('入场延迟错开（A 0ms / B 110ms / 终裁 220ms）', same.includes('--d:0ms') && same.includes('--d:110ms') && same.includes('--d:220ms'));

  const pick = dualRail({ decision: 'pick_b', final_score: 13, band_gap: 1 }, 15, { score: 10 }, { score: 13 });
  ok('差一档：机制文案标出采 B', pick.includes('差 1 档 · 第三方仲裁采 B'));
  ok('差一档：A 与 B 刻度分离', pick.includes('--ratio:0.6667') && pick.includes('--ratio:0.8667'));
  const pickA = dualRail({ decision: 'pick_a', final_score: 10, band_gap: 1 }, 15, { score: 10 }, { score: 13 });
  ok('差一档采 A 文案正确', pickA.includes('第三方仲裁采 A'));

  const over = dualRail({ decision: 'same_band', final_score: 20 }, 15, { score: 20 }, { score: 20 });
  ok('超出满分时比例夹到 1', over.includes('--ratio:1.0000'));
  const empty = dualRail({ decision: 'same_band' }, 15, undefined, undefined);
  ok('缺初评数据时显示 ? 且不崩', empty.includes('>?'));
  ok('缺初评数据时比例退化为 0', empty.includes('--ratio:0.0000'));
}

console.log('Key 识别（贴 Key 自动认供应商）');
{
  ok('OpenRouter 前缀认出', detectProviderByKey('sk-or-v1-abc123') === 'openrouter');
  ok('Anthropic 前缀认出', detectProviderByKey('sk-ant-api03-xyz') === 'anthropic');
  ok('Gemini 前缀认出', detectProviderByKey('AIzaSyABC') === 'gemini');
  ok('OpenAI proj 前缀认出', detectProviderByKey('sk-proj-' + 'a'.repeat(24)) === 'openai');
  ok('智谱 id.secret 格式认出', detectProviderByKey('0123456789abcdef.0123456789abcdef') === 'glm');
  ok('火山 UUID 认出', detectProviderByKey('123e4567-e89b-12d3-a456-426614174000') === 'ark');
  ok('国内通用 sk- 不乱猜（宁可不猜也不猜错）', detectProviderByKey('sk-' + 'a'.repeat(32)) === null);
  ok('空 Key 不猜', detectProviderByKey('') === null);
  ok('Key 与所选供应商不符时能提示', keyLooksMismatched('deepseek', 'sk-ant-api03-xyz') !== null);
  ok('Key 与所选供应商相符时不误报', keyLooksMismatched('deepseek', 'sk-' + 'a'.repeat(32)) === null);
  ok('没设格式规则的供应商不误报', keyLooksMismatched('qwen', 'sk-随便什么') === null);
  ok('空 Key 不提示', keyLooksMismatched('deepseek', '') === null);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
