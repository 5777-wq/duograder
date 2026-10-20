// DuoGrader 共享代理内核 · 单一真源
//
// Pages Functions 与 Cloudflare Workers 两套入口共用这一份实现（sync_app.py 负责同步副本，
// CI 断言副本与真源逐字节一致），避免两套实现手工分叉——历史上两套已经漂移过一次
// （Worker 缺匿名通道/免费额度/配额查询，Pages 缺 IPv6 归并）。
//
// 安全设计（两套入口一致）：
//   · 上游地址写死，客户端无法指定目标；不转发客户端原始头
//   · API Key 只存服务端 secret；客户端只持邀请码
//   · 匿名通道有免费额度配额（按 IP + 设备双计数）与全站每日上限
//   · 匿名/登录通道都做模型白名单与 max_tokens 封顶，避免拿别人的 key 跑无上限生成
//   · CORS 白名单只放行本应用来源；自定义头与响应头都正确 expose

export const DEFAULTS = {
  FREE_LIMIT: 50,             // 每 IP/设备免费次数
  ANON_DAILY_CAP: 300,        // 全站匿名每日总上限（防代理池脚本薅）
  MAX_BODY: 20 * 1024 * 1024,
  ANON_MAX_TOKENS: 12000,     // 匿名通道单次输出上限（控单次成本）
  AUTHED_MAX_TOKENS: 32000,   // 邀请码通道单次输出上限
  RATE_WINDOW_MS: 10 * 60 * 1000,
  RATE_MAX: 120,              // 每 IP 每窗口最大请求数
  RATE_MAX_KEYS: 20000,       // 限速表键数上限，超了整体清扫（防 isolate 内存无界增长）
  RATE_SWEEP_EVERY: 64,       // 每多少次写入清扫一次过期键
  UPSTREAM_BASE: 'https://api.minimaxi.com/v1',
  UPSTREAM_MODEL: 'MiniMax-M3.1-Flash-Preview',
  FREE_TTL: 60 * 60 * 24 * 180, // 180 天
  DAILY_TTL: 60 * 60 * 48,      // 48 小时
  DEFAULT_ORIGINS: ['https://duograder.pages.dev', '*.duograder.pages.dev'],
};

/* ---------------- CORS ---------------- */

function originMatches(origin, pattern) {
  if (!pattern) return false;
  if (pattern === '*') return true;
  if (pattern === origin) return true;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2).toLowerCase();
    let host = '';
    try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
    // 通配必须按域分量匹配：*.example.com 不能匹配 evil-example.com
    return host === base || host.endsWith('.' + base);
  }
  return false;
}

function allowedOrigins(env) {
  const extra = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = extra.length ? extra : DEFAULTS.DEFAULT_ORIGINS;
  // 本地自测永远放行
  list.push('http://localhost', 'http://127.0.0.1');
  return list;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = allowedOrigins(env).some((p) => originMatches(origin, p));
  const h = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    // X-Device-Id 必须放行：前端每个请求都带它，漏了浏览器预检会拦掉整条链路
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id',
    // 不 expose 的话 JS 读不到 X-Free-Remaining，额度角标永远不更新
    'Access-Control-Expose-Headers': 'X-Free-Remaining',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

/* ---------------- IP / 限速 ---------------- */

export function resolveIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  const xff = (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim();
  const raw = cf || xff || 'unknown';
  // IPv6 按 /64 前缀归并：隐私扩展会轮换接口标识但前缀不变，防同设备反复换地址
  return raw.includes(':') ? 'v6:' + raw.split(':').slice(0, 4).join(':') : raw;
}

export function sanitizeDid(v) {
  return String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function makeRateLimiter() {
  const buckets = (globalThis.__dg_rl ||= new Map());
  let sinceSweep = 0;
  return (ip) => {
    const now = Date.now(), win = DEFAULTS.RATE_WINDOW_MS;
    const arr = (buckets.get(ip) || []).filter((t) => now - t < win);
    const limited = arr.length >= DEFAULTS.RATE_MAX;
    if (!limited) arr.push(now);
    buckets.set(ip, arr);
    // 定期清扫过期键：否则每个新 IP 都在 Map 里留一条永不过期的记录，长驻 isolate 下无界增长
    if (++sinceSweep >= DEFAULTS.RATE_SWEEP_EVERY) {
      sinceSweep = 0;
      for (const [k, v] of buckets) {
        const live = v.filter((t) => now - t < win);
        if (live.length) buckets.set(k, live); else buckets.delete(k);
      }
      if (buckets.size > DEFAULTS.RATE_MAX_KEYS) buckets.clear();
    }
    return limited;
  };
}

/* ---------------- 配额计数 ---------------- */

function cnDate() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }

async function readCount(env, key) {
  if (!env.FREE_KV) return 0;
  try {
    const raw = await env.FREE_KV.get(key);
    const n = raw ? parseInt(raw, 10) || 0 : 0;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

async function writeCount(env, key, n, ttl) {
  if (!env.FREE_KV) return;
  try { await env.FREE_KV.put(key, String(n), { expirationTtl: ttl }); } catch { /* 计数失败不阻断主流程 */ }
}

// isolate 内串行化「读-判-写」：同 isolate 的并发请求不再能同时越过配额检查
// （旧实现是先放行、上游成功后再计数，并发下计数完全失效）
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.then(() => {}, () => {});
  return run;
}

async function quotaInfo(env, ip, did, limit) {
  const ipN = await readCount(env, 'free:' + ip);
  const devN = did ? await readCount(env, 'dev:' + did) : 0;
  const used = Math.max(ipN, devN);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

// 预扣：先占额度再发上游请求，上游失败再退
async function reserve(env, ip, did, limit, dailyCap) {
  return withLock(async () => {
    const dayKey = 'daily:' + cnDate();
    const dayN = await readCount(env, dayKey);
    if (dayN >= dailyCap) return { ok: false, reason: 'daily', used: dayN, remaining: 0 };

    const ipKey = 'free:' + ip;
    const devKey = did ? 'dev:' + did : null;
    const ipN = await readCount(env, ipKey);
    const devN = devKey ? await readCount(env, devKey) : 0;
    const used = Math.max(ipN, devN);
    if (used >= limit) return { ok: false, reason: 'quota', used, remaining: 0 };

    await writeCount(env, ipKey, ipN + 1, DEFAULTS.FREE_TTL);
    if (devKey) await writeCount(env, devKey, devN + 1, DEFAULTS.FREE_TTL);
    await writeCount(env, dayKey, dayN + 1, DEFAULTS.DAILY_TTL);
    return { ok: true, used: used + 1, remaining: Math.max(0, limit - (used + 1)) };
  });
}

async function refund(env, ip, did) {
  return withLock(async () => {
    const ipKey = 'free:' + ip;
    const ipN = await readCount(env, ipKey);
    if (ipN > 0) await writeCount(env, ipKey, ipN - 1, DEFAULTS.FREE_TTL);
    if (did) {
      const devKey = 'dev:' + did;
      const dN = await readCount(env, devKey);
      if (dN > 0) await writeCount(env, devKey, dN - 1, DEFAULTS.FREE_TTL);
    }
    const dayKey = 'daily:' + cnDate();
    const dN = await readCount(env, dayKey);
    if (dN > 0) await writeCount(env, dayKey, dN - 1, DEFAULTS.DAILY_TTL);
  });
}

/* ---------------- 上游 ---------------- */

function allowedModels(env, opts) {
  const fromEnv = [env.UPSTREAM_MODEL, env.UPSTREAM_VISION_MODEL].filter(Boolean);
  const fromOpts = (opts && opts.models) || [];
  const list = [...new Set([...fromOpts, ...fromEnv])].filter(Boolean);
  return list.length ? list : [DEFAULTS.UPSTREAM_MODEL];
}

function sanitizePayload(payload, { models, maxTokens }) {
  const out = { ...payload };
  // 模型白名单：客户端不能借你的 key 调用任意模型
  if (models.length && out.model && !models.includes(out.model)) out.model = models[0];
  // max_tokens 封顶：限制单次成本，防止匿名通道被拿来跑超长生成
  const mt = Number(out.max_tokens);
  out.max_tokens = Number.isFinite(mt) && mt > 0 ? Math.min(Math.floor(mt), maxTokens) : maxTokens;
  // 强制非流式：代理按 JSON 转发，流式会让客户端解析失败
  out.stream = false;
  return out;
}

/* ---------------- 主处理 ---------------- */

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

const MSG_BAD_CODE = '邀请码无效：请点右上角「登录」输入邀请码，或在设置里使用自己的 API Key。';

export async function handleProxy(request, env, opts = {}) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const limit = Number(env.FREE_LIMIT) || DEFAULTS.FREE_LIMIT;
  const dailyCap = Number(env.ANON_DAILY_CAP) || DEFAULTS.ANON_DAILY_CAP;
  const ip = resolveIp(request);
  const did = sanitizeDid(request.headers.get('X-Device-Id'));

  const rateLimited = makeRateLimiter();
  if (rateLimited(ip)) return json({ error: { message: '请求过于频繁，请稍后再试。' } }, 429, cors);

  const code = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const authed = !!code && !!env.INVITE_CODE && code === env.INVITE_CODE;
  const anonymous = !code;
  // 带了码但不对 → 401；完全不带码 → 匿名免费额度通道
  if (!authed && !anonymous) return json({ error: { message: MSG_BAD_CODE } }, 401, cors);

  const url = new URL(request.url);
  const models = allowedModels(env, opts);

  // 免费额度查询（只读不计数）
  if (request.method === 'GET' && url.pathname.endsWith('/quota')) {
    if (authed) return json({ unlimited: true }, 200, cors);
    if (!env.FREE_KV) return json({ error: { message: '免费额度未配置' } }, 404, cors);
    return json(await quotaInfo(env, ip, did, limit), 200, cors);
  }

  // 型号清单不打上游，直接回报内置型号（供前端「拉取模型/诊断」链路）
  if (request.method === 'GET' && url.pathname.endsWith('/models')) {
    return json({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }, 200, cors);
  }

  if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let reserved = null;
    if (!authed) {
      if (!env.MINIMAX_API_KEY || !env.FREE_KV) {
        return json({ error: { message: MSG_BAD_CODE } }, 401, cors);
      }
      reserved = await reserve(env, ip, did, limit, dailyCap);
      if (!reserved.ok) {
        const msg = reserved.reason === 'daily'
          ? `今日全站免费体验额度已被领完（每日 ${dailyCap} 次），明天 0 点后再来，或在设置里使用自己的 API Key。`
          : `本 IP/本设备的 ${limit} 次免费批改额度已用完（180 天后重置）。可在设置里换成自己的 API Key 继续使用。`;
        return json({ error: { message: msg } }, 429, cors);
      }
    }

    const upstreamBase = (opts.upstreamBase || env.UPSTREAM_BASE || DEFAULTS.UPSTREAM_BASE).replace(/\/+$/, '');
    try {
      const raw = await request.text();
      if (raw.length > DEFAULTS.MAX_BODY) {
        if (reserved) await refund(env, ip, did);
        return json({ error: { message: '请求过大（上限 20MB）。' } }, 413, cors);
      }
      let payload;
      try { payload = JSON.parse(raw); } catch {
        if (reserved) await refund(env, ip, did);
        return json({ error: { message: '请求体不是合法 JSON。' } }, 400, cors);
      }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        // 注入深度推理：reasoning_effort='high'（max 会被 CF 524 掐断；客户端显式给定值优先）
        if (payload.reasoning_effort === undefined) payload.reasoning_effort = 'high';
        payload = sanitizePayload(payload, {
          models,
          maxTokens: authed ? DEFAULTS.AUTHED_MAX_TOKENS : DEFAULTS.ANON_MAX_TOKENS,
        });
      }
      const resp = await fetch(upstreamBase + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.MINIMAX_API_KEY },
        body: JSON.stringify(payload),
      });
      // 上游失败不消耗额度
      if (reserved && resp.status !== 200) await refund(env, ip, did);
      const headers = { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', ...cors };
      if (reserved) {
        headers['X-Free-Remaining'] = String(reserved.remaining);
      }
      return new Response(resp.body, { status: resp.status, headers });
    } catch (e) {
      if (reserved) await refund(env, ip, did);
      throw e;
    }
  }

  return json({ error: { message: 'Not Found' } }, 404, cors);
}
