// DuoGrader 核心逻辑（纯函数，与 skill/scripts/*.py 保持同口径）
// 浏览器与 Node 均可加载（ESM）。

export const RECOMMENDED = {
  'english-i_small': [100, 100],
  'english-i_large': [160, 200],
  'english-ii_small': [100, 100],
  'english-ii_large': [150, 150],
};

export const BAND_TABLE = {
  10: { 5: [9, 10], 4: [7, 8], 3: [5, 6], 2: [3, 4], 1: [1, 2], 0: [0, 0] },
  20: { 5: [17, 20], 4: [13, 16], 3: [9, 12], 2: [5, 8], 1: [1, 4], 0: [0, 0] },
  15: { 5: [13, 15], 4: [10, 12], 3: [7, 9], 2: [4, 6], 1: [1, 3], 0: [0, 0] },
};

export const MAX_SCORES = { 'english-i_large': 20, 'english-ii_large': 15, 'english-i_small': 10, 'english-ii_small': 10 };

const WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+(?:[.,]\d+)*%?/g;
const CHINESE_RE = /[\u4e00-\u9fff]/g;

export function countWords(text) {
  return (text.match(WORD_RE) || []).length;
}

export function splitParagraphs(text) {
  const blocks = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (blocks.length === 1 && blocks[0].includes('\n')) {
    return { paras: blocks[0].split('\n').map((l) => l.trim()).filter(Boolean), basis: 'single_newline' };
  }
  return { paras: blocks, basis: 'blank_line' };
}

export function lengthStatus(count, lo, hi) {
  const ratio = lo ? count / lo : 1;
  let status;
  if (ratio >= 1.0) status = 'ok';
  else if (ratio >= 0.8) status = 'soft_ok';
  else if (ratio >= 2 / 3) status = 'soft_short';
  else if (ratio >= 0.5) status = 'short_two_thirds';
  else status = 'short_half';
  return { ratio, status, overlong: hi && hi !== lo && count > hi * 1.5 };
}

export function mechanicalFlags(text) {
  const flags = [];
  const zh = (text.match(CHINESE_RE) || []).length;
  if (zh) flags.push({ type: 'chinese_chars', count: zh, detail: '作文正文含中文字符（疑似混入）' });
  const repeated = text.match(/\b([A-Za-z]+)\s+\1\b/gi) || [];
  if (repeated.length) {
    const uniq = [...new Set(repeated.map((r) => r.trim().split(/\s+/)[0].toLowerCase()))].slice(0, 8);
    flags.push({ type: 'repeated_word', count: repeated.length, detail: '疑似相邻重复词: ' + uniq.join(', ') });
  }
  const miss = (text.match(/[A-Za-z][,.;:!?][A-Za-z]/g) || []).length;
  if (miss) flags.push({ type: 'missing_space_after_punct', count: miss, detail: '标点后疑似缺空格' });
  const dp = (text.replace(/\.\.\./g, '').match(/[,;:!?]{2,}/g) || []).length;
  if (dp) flags.push({ type: 'double_punct', count: dp, detail: '连续标点（省略号除外）' });
  const sentences = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const lower = sentences.filter((s) => /^[a-z]/.test(s)).slice(0, 3);
  if (lower.length) flags.push({ type: 'lowercase_sentence_start', count: lower.length, detail: '句首小写: ' + lower.map((s) => s.slice(0, 25)).join(' | ') });
  return flags;
}

export function precheck(text, track, task) {
  const words = countWords(text);
  const { paras, basis } = splitParagraphs(text);
  const sentences = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const [lo, hi] = RECOMMENDED[`${track}_${task}`];
  const len = lengthStatus(words, lo, hi);
  const out = {
    track, task,
    word_count: words,
    recommended_words: [lo, hi],
    ratio_to_minimum: Math.round(len.ratio * 1000) / 1000,
    length_status: len.status,
    overlong: len.overlong,
    paragraph_count: paras.length,
    paragraph_basis: basis,
    paragraph_word_counts: paras.map(countWords),
    sentence_count: sentences.length,
    avg_sentence_words: sentences.length ? Math.round((words / sentences.length) * 10) / 10 : 0,
    mechanical_flags: mechanicalFlags(text),
  };
  if (task === 'small') {
    out.small_writing_format = {
      salutation: /^\s*dear\s+/im.test(text),
      closing: /yours\s+(sincerely|faithfully|truly)/im.test(text) || /^\s*best\s+wishes/im.test(text),
      signature_li_ming: /^\s*li\s+ming\s*\.?\s*$/im.test(text),
    };
  }
  return out;
}

export function snapHalfDown(x) {
  return Math.floor(x * 2 + 0.499999) / 2;
}

// —— 题型/科目自动识别（依据题面里的词数、分值、体裁关键词） ——
export function detectTaskType(promptText) {
  const t = String(promptText || '');
  const res = { task: null, track: null, evidence: [] };
  const hasSmall = /about\s*100\s*words|10\s*points/i.test(t);
  const hasE1Large = /160\s*[-–—~至到]\s*200\s*words|20\s*points/i.test(t);
  const hasE2Large = /about\s*150\s*words|15\s*points/i.test(t);
  if (hasE1Large) {
    res.task = 'large'; res.track = 'english-i';
    res.evidence.push('160-200 词 / 20 分 → 英语一大作文');
  } else if (hasE2Large && !hasSmall) {
    res.task = 'large'; res.track = 'english-ii';
    res.evidence.push('约 150 词 / 15 分 → 英语二大作文');
  } else if (hasSmall && !hasE2Large && !hasE1Large) {
    res.task = 'small';
    res.evidence.push('约 100 词 / 10 分 → 小作文');
  } else if (hasSmall && (hasE2Large || hasE1Large)) {
    // 一页同时含 Part A 和 Part B 信息：默认按大作文，请人工确认
    res.task = 'large'; res.track = hasE1Large ? 'english-i' : 'english-ii';
    res.evidence.push('题面同时含小/大作文信息，暂按大作文——若写的是小作文请点改');
  }
  if (!res.task) {
    if (/\bchart\b|\btable\b|\bgraph\b|\bstatistics\b|图表/i.test(t)) {
      res.task = 'large'; res.track = 'english-ii';
      res.evidence.push('图表体裁 → 英语二大作文');
    } else if (/\bpicture\b|\bdrawing\b|\bcartoon\b|\bphotos?\b|图画|漫画/i.test(t)) {
      res.task = 'large'; res.track = 'english-i';
      res.evidence.push('图画体裁 → 英语一大作文');
    } else if (/\bemail\b|\bletter\b|\bnotice\b|\breply\b|书信|邮件|通知/i.test(t)) {
      res.task = 'small';
      res.evidence.push('书信/通知体裁 → 小作文');
    }
  }
  return res;
}

// —— 模型输出解析（容错：围栏、首尾杂质、数组对象间漏逗号、JSON 后跟注释文字） ——
export function parseModelJSON(text) {
  let raw = String(text).trim();
  raw = raw.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
  const tries = [];
  if (first >= 0 && last > first) tries.push(raw.slice(first, last + 1));
  tries.push(raw);
  let err;
  for (const c of tries) {
    try { return { ok: true, obj: JSON.parse(c) }; }
    catch (e) {
      err = e;
      // "Unexpected non-whitespace character after JSON at position N"
      // → JSON 本体在 N 处已结束，后面是模型的注释文字，直接截断重试
      const m = /after JSON at position (\d+)/.exec(e.message || '');
      if (m) {
        try { return { ok: true, obj: JSON.parse(c.slice(0, Number(m[1]))) }; }
        catch (e2) { err = e2; }
      }
      const repaired = c.replace(/\}\s*\{\s*"/g, '},{"');
      if (repaired !== c) {
        try { return { ok: true, obj: JSON.parse(repaired) }; }
        catch (e2) { err = e2; }
      }
    }
  }
  return { ok: false, error: 'JSON 解析失败: ' + (err?.message || '未找到 JSON') };
}

const EPS = 0.01;
const negated = (s) => s.replace(/(并无|不是|没有|不算|不属于|不含|非)错误/g, '');

export function validateReport(report, essayText) {
  const failures = [], warnings = [];
  const essayNorm = essayText.trim().split(/\s+/).join(' ');
  const norm = (s) => String(s || '').trim().split(/\s+/).join(' ');

  const meta = report.meta || {};
  const key = `${meta.exam_track}_${meta.task}`;
  if (!(key in MAX_SCORES) || MAX_SCORES[key] !== meta.max_score)
    failures.push(`meta 组合非法：${meta.exam_track}/${meta.task}/${meta.max_score}`);
  if (!Number.isInteger(meta.word_count_reported) || meta.word_count_reported <= 0)
    failures.push('meta.word_count_reported 必须为正整数（引用预检值）');

  const band = report.band || {}, b = band.band;
  if (!Number.isInteger(b) || !(BAND_TABLE[meta.max_score] || {})[b]) failures.push(`档位非法: ${b}`);
  else {
    const expect = BAND_TABLE[meta.max_score][b];
    if (String(band.range) !== String(expect)) failures.push(`档位区间错: ${JSON.stringify(band.range)}，应为 ${JSON.stringify(expect)}`);
  }
  if (String(band.rationale || '').length < 20) failures.push('band.rationale 太短，须引用档位描述关键词');

  const dims = (report.scores?.dimensions) || [];
  let sum = 0;
  for (const d of dims) {
    if (!(d.score >= 0 && d.score <= d.max + EPS)) failures.push(`维度 ${d.name} 分值越界: ${d.score}/${d.max}`);
    if (norm(d.evidence).length < 5) failures.push(`维度 ${d.name} 缺少原文证据`);
    sum += d.score || 0;
  }
  if (!dims.length) failures.push('维度分为空');
  const total = report.scores?.total;
  if (Math.abs(sum - total) > EPS) failures.push(`维度分之和 ${sum} != 总分 ${total}`);
  if (Number.isInteger(b) && BAND_TABLE[meta.max_score]?.[b]) {
    const [lo, hi] = BAND_TABLE[meta.max_score][b];
    if (!(lo - EPS <= sum && sum <= hi + EPS)) failures.push(`维度分之和 ${sum} 不在档位区间 [${lo}, ${hi}] 内`);
  }
  if (report.consistency?.in_band_range !== true) failures.push('consistency.in_band_range 必须为 true');

  (report.sentence_edits || []).forEach((e, i) => {
    if (!['error', 'awkward', 'style'].includes(e.severity)) failures.push(`逐句批改[${i}] severity 非法: ${e.severity}`);
    if (e.severity === 'style' && /错误/.test(negated(e.issue || ''))) failures.push(`逐句批改[${i}] style 级不得使用"错误"措辞（否定式除外）`);
    if (norm(e.original) && !essayNorm.includes(norm(e.original))) warnings.push(`逐句批改[${i}] original 与原文不符`);
  });

  const n = (report.top_problems || []).length;
  if (!(n >= 2 && n <= 3)) failures.push(`top_problems 应为 2-3 条，实际 ${n} 条`);
  return { failures, warnings };
}

// —— 同档合并（rubric v1.2：确定性算术，与 average_reports.py 同口径） ——
export function mergeSameBand(a, b) {
  const ba = a.band.band, bb = b.band.band;
  if (ba !== bb) return { ok: false, reason: 'arbiter' };
  const da = Object.fromEntries(a.scores.dimensions.map((d) => [d.name, d]));
  const db = Object.fromEntries(b.scores.dimensions.map((d) => [d.name, d]));
  const names = Object.keys(da);
  if (names.join() !== Object.keys(db).join()) return { ok: false, reason: 'dimension_names' };
  const dims = names.map((n) => ({
    name: n, max: da[n].max, score: (da[n].score + db[n].score) / 2,
    note: `A给${da[n].score}，B给${db[n].score}，均值${(da[n].score + db[n].score) / 2}`,
  }));
  const dimSum = dims.reduce((s, d) => s + d.score, 0);
  const total = snapHalfDown(dimSum);
  const maxScore = a.meta.max_score;
  const [lo, hi] = BAND_TABLE[maxScore][ba];
  if (!(lo <= total && total <= hi)) return { ok: false, reason: 'out_of_band' };
  return {
    ok: true,
    final: {
      needs_regrade: false, decision: 'same_band',
      final_band: ba, final_score: total, final_range: [lo, hi],
      dimensions: dims,
      rationale: `两位阅卷员同档（band_gap=0），按 rubric 第7节逐维取均值、总分收敛至0.5粒度（尾数从严），脚本确定性合并。`,
      initial: [
        { grader: 'A', band: ba, score: a.scores.total },
        { grader: 'B', band: bb, score: b.scores.total },
      ],
      band_gap: 0,
      score_gap: Math.abs(a.scores.total - b.scores.total),
      report_a: a, report_b: b,
    },
  };
}

// —— 提示词（内核 v1.0）：优先使用 prompts/ 文件模板，缺省用内置兜底 ——
const BUILTIN_GRADER_SYSTEM = '你是一名独立的考研英语作文阅卷员，参加双盲阅卷。你只能使用用户消息中列出的材料，忽略其他一切上下文。严格按评分规则执行，最终只输出一个 JSON 对象本体（不要解释、不要 markdown 围栏）。';
const BUILTIN_GRADER_TASK = `【评分规则（唯一依据，完整阅读）】
{{RUBRIC}}

【输出契约（JSON Schema）】
{{SCHEMA}}

【事实清单（字数与段落由脚本计算，只准引用不准自算）】
{{FACTS}}

【题面】
{{PROMPT}}

【考生作文】
{{ESSAY}}

严格按规则第 6 节"评分流程"执行，特别注意：第 5 节三级错误分类（拿不准一律降级，宁漏勿冤）；维度分之和必须落在档位区间内。输出完全符合 schema 的 JSON 报告。`;

function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{{${k}}}`);
}

export function graderMessages({ rubric, schema, facts, prompt, essay, kernel }) {
  const sys = kernel?.graderSystem || BUILTIN_GRADER_SYSTEM;
  const tpl = kernel?.graderTask || BUILTIN_GRADER_TASK;
  const user = fillTemplate(tpl, {
    RUBRIC: rubric, SCHEMA: schema, FACTS: JSON.stringify(facts),
    PROMPT: prompt || '未提供——切题维度按暂定处理', ESSAY: essay,
  });
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

export function arbiterMessages({ rubric, essay, prompt, reportA, reportB, kernel }) {
  const sys = kernel?.graderSystem
    ? '你是考研英语作文双盲阅卷的仲裁员。只输出一个 JSON 对象本体（不要解释、不要 markdown 围栏）。'
    : '你是考研英语作文双盲阅卷的仲裁员。只输出一个 JSON 对象本体（不要解释、不要 markdown 围栏）。';
  const tpl = kernel?.arbiterTask;
  let user;
  if (tpl) {
    user = fillTemplate(tpl, {
      RUBRIC: rubric, ESSAY: essay, PROMPT: prompt || '未提供',
      REPORT_A: JSON.stringify(reportA), REPORT_B: JSON.stringify(reportB),
    });
  } else {
    user = [
      '【评分规则（重点读第 2、3、7 节）】', rubric, '',
      '【考生作文】', essay, '',
      '【题面】', prompt ? prompt : '未提供', '',
      '【阅卷员 A 报告】', JSON.stringify(reportA), '',
      '【阅卷员 B 报告】', JSON.stringify(reportB), '',
      '按规则第 7 节双评与仲裁协议裁决：差一档必须在两个档位中二选一并引用档位描述原文说明依据，不允许和稀泥取中间分；差两档及以上 needs_regrade=true。',
      '输出 JSON：{"needs_regrade":bool,"decision":"pick_a|pick_b|void","final_band":int,"final_score":number,"final_range":[lo,hi],"dimensions":[{"name","max","score","note"}],"rationale":"引用档位描述的裁决理由","initial":[{"grader":"A","band":int,"score":number},{"grader":"B","band":int,"score":number}],"band_gap":int,"score_gap":number}',
    ].join('\n');
  }
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

export function repairMessages(baseMessages, badOutput, problems) {
  return [
    ...baseMessages,
    { role: 'assistant', content: String(badOutput).slice(0, 12000) },
    { role: 'user', content: `你上一条输出的报告未通过机器校验，问题如下：\n${problems.map((p) => '- ' + p).join('\n')}\n请修正这些问题，重新输出完整的、完全符合 schema 的 JSON 报告。只输出 JSON 本体。` },
  ];
}

// —— API 诊断（仿主流 harness 的连接检查） ——
// 无 key 探测：只要浏览器能"读到"任意 HTTP 状态码（包括 401），就证明跨域直连可行
export function probeCors(baseURL, timeoutMs = 8000) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  return fetch(base + '/models', { headers: { Authorization: 'Bearer sk-duograder-cors-probe' }, signal: ctrl.signal })
    .then((res) => ({ ok: true, status: res.status, ms: Date.now() - t0 }))
    .catch((e) => ({ ok: false, status: 0, ms: Date.now() - t0, error: e.name === 'AbortError' ? '超时' : 'fetch 失败' }))
    .finally(() => clearTimeout(timer));
}

export function fetchModelList({ baseURL, apiKey }) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  return fetch(base + '/models', { headers: { Authorization: 'Bearer ' + (apiKey || '') } })
    .then(async (res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const ids = [...new Set((Array.isArray(j) ? j : (j.data || [])).map((m) => m.id || m.name).filter(Boolean))].sort();
      if (!ids.length) throw new Error('返回中没有模型');
      return ids;
    });
}

export function chatTestMessages() {
  return [{ role: 'user', content: '只回复两个字：正常' }];
}

export function visionTestMessages(imageDataUrl) {
  return [
    { role: 'system', content: '你看图回答问题，答案只有几个字。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张纯色小图是什么颜色？只回答颜色名。' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

export function httpErrorHint(status) {
  return {
    401: 'API Key 无效或未填',
    403: '无权限 / 欠费 / 地域限制',
    404: '地址路径或模型名不对',
    429: '限流，稍后再试',
  }[status] || (status >= 500 ? '服务商内部错误' : '');
}

// —— 拍照转写（视觉模型读手写） ——
// 合并模式：题面与手写作文可能在同一张/一组照片里，由模型分离
export function transcriptionMessages(imageDataUrls, kind) {
  if (kind === 'combined') {
    return [
      { role: 'system', content: '你是手写照片转写助手，只输出一个 JSON 对象本体，不要解释，不要围栏。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '照片里是考研英语作文的完整材料：可能包含印刷的题面（Directions、图表/图画说明）和考生手写的作文（手写部分可能在多张照片中连续）。请分离并转写为 JSON：\n{"prompt": "印刷题面全文（含图表数据说明；若照片里没有题面则输出空字符串）", "essay": "考生手写作文全文（逐词转写，不纠错不改写，保留拼写错误；段落间用一个空行分隔；无法辨认的词用 [?]；多张照片按顺序拼接）"}\n注意：手写作文里可能引用题面的词，凡是手写体都属于 essay；印刷体/照片描述属于 prompt。只输出 JSON。' },
          ...imageDataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
        ],
      },
    ];
  }
  const instruction = kind === 'prompt'
    ? '转写图片中的考研英语作文题面（可能包含 Directions、要求、分值，以及图表或图画的文字描述）。完整保留全部信息，中文说明照原样保留，段落间用空行。只输出转写文本本体，不要解释，不要围栏。'
    : '转写图片中的手写英语作文。逐词转写：不要纠错、不要补全、不要改写考生写的内容（拼写错误也原样保留）；保留段落结构，段落之间用一个空行分隔；无法辨认的词用 [?] 占位；多张图片按顺序是同一篇作文的连续部分。只输出转写文本本体，不要解释，不要围栏。';
  return [
    { role: 'system', content: '你是手写照片转写助手，只输出转写结果文本。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        ...imageDataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
      ],
    },
  ];
}

// —— API 调用（OpenAI 兼容）：60s 超时 + 429/5xx/网络错误指数退避重试 ——
export async function callChat(settings, messages, { temperature = 0.3, signal, timeout = 60000, retries = 2, onUsage } = {}) {
  const base = String(settings.baseURL || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API 地址（设置里选一个预设或填 baseURL）');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const onOuterAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw new Error('已取消'); }
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (settings.apiKey || '') },
        body: JSON.stringify({ model: settings.model, messages, temperature, stream: false }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        const err = new Error(`API 返回 HTTP ${res.status}: ${t.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('API 返回为空：' + JSON.stringify(data).slice(0, 200));
      if (onUsage && data.usage) onUsage(data.usage);
      return content;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw new Error('已取消');
      const timedOut = e.name === 'AbortError';
      const retryable = timedOut || e.status === 429 || e.status >= 500 || e.name === 'TypeError';
      if (!retryable || attempt === retries) {
        if (timedOut) throw new Error(`请求超时（${timeout / 1000}s）`);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // 1s → 2s
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }
  throw lastErr;
}

export const PRESETS = [
  // status: ok=浏览器可直连 / blocked=浏览器被拦 / local=仅本地 http 页（2026-10-09 实测）
  { id: 'deepseek', name: 'DeepSeek 官方', status: 'ok', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', vmodel: 'deepseek-flash' },
  { id: 'glm', name: '智谱 GLM 官方', status: 'ok', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', vmodel: 'glm-4v-flash' },
  { id: 'kimi', name: 'Kimi 月之暗面', status: 'ok', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', vmodel: 'moonshot-v1-8k-vision-preview' },
  { id: 'qwen', name: '通义千问 · 百炼', status: 'ok', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vmodel: 'qwen-vl-plus' },
  { id: 'ark', name: '火山方舟 · 豆包', status: 'blocked', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1.5-pro-32k', vmodel: 'doubao-1.5-vision-pro-32k' },
  { id: 'openai', name: 'OpenAI 官方', status: 'ok', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o', vmodel: 'gpt-4o-mini' },
  { id: 'anthropic', name: 'Anthropic Claude', status: 'blocked', baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', vmodel: 'claude-sonnet-4-5' },
  { id: 'gemini', name: 'Google Gemini', status: 'ok', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', vmodel: 'gemini-2.0-flash' },
  { id: 'siliconflow', name: '硅基流动', status: 'ok', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', vmodel: 'deepseek-ai/DeepSeek-VL2' },
  { id: 'openrouter', name: 'OpenRouter', status: 'ok', baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', vmodel: 'google/gemini-2.0-flash-001' },
  { id: 'ollama', name: 'Ollama 本地', status: 'local', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', vmodel: 'qwen2.5vl:7b' },
  { id: 'lmstudio', name: 'LM Studio 本地', status: 'local', baseURL: 'http://localhost:1234/v1', model: 'local-model', vmodel: '' },
  { id: 'custom', name: '自定义供应商', status: null, baseURL: '', model: '', vmodel: '' },
];
export const STATUS_LABEL = { ok: '可直连', blocked: '需反代', local: '仅本地' };
