// DuoGrader 邀请码代理 · Pages Functions 版
// 与网页同域（duograder.pages.dev/v1/*），国内可直连（workers.dev 被墙时的主路径）。
// 安全设计与 workers/invite-proxy/worker.js 完全一致：
// 无存储纯转发；上游写死；key 只存 Pages 加密 secret（wrangler pages secret put）；
// 不转发客户端原始头；CORS 白名单只放行本应用来源。

const UPSTREAM_BASE = 'https://api.minimaxi.com/v1';
const UPSTREAM_MODEL = 'MiniMax-M3.1-Flash-Preview';
const MAX_BODY = 20 * 1024 * 1024;
const FREE_LIMIT = 50;
const ANON_DAILY_CAP = 300;   // 全站匿名每日总上限（防代理池脚本薅）

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed =
    origin === 'https://duograder.pages.dev' ||
    (/^https:\/\/[a-z0-9-]+\.duograder\.pages\.dev$/.test(origin)) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const h = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

function rateLimited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 120;
  const buckets = (globalThis.__rl ||= new Map());
  const arr = (buckets.get(ip) || []).filter((t) => now - t < win);
  const limited = arr.length >= max;
  if (!limited) arr.push(now);
  buckets.set(ip, arr);
  return limited;
}

function freeKey(ip) { return 'free:' + ip; }
async function freeGet(env, ip) {
  if (!env.FREE_KV) return null;
  try {
    const raw = await env.FREE_KV.get(freeKey(ip));
    const n = raw ? parseInt(raw, 10) || 0 : 0;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}
async function freeBump(env, ip) {
  try {
    const n = ((await freeGet(env, ip)) || 0) + 1;
    await env.FREE_KV.put(freeKey(ip), String(n), { expirationTtl: 60 * 60 * 24 * 180 });
    return n;
  } catch { return null; }
}

function cnDate() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
async function dailyGet(env) {
  if (!env.FREE_KV) return 0;
  try {
    const raw = await env.FREE_KV.get('daily:' + cnDate());
    const n = raw ? parseInt(raw, 10) || 0 : 0;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}
async function dailyBump(env) {
  try {
    const n = ((await dailyGet(env)) || 0) + 1;
    await env.FREE_KV.put('daily:' + cnDate(), String(n), { expirationTtl: 60 * 60 * 48 });
    return n;
  } catch { return null; }
}

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const rawIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  // IPv6 按 /64 前缀归并：隐私扩展会轮换接口标识但前缀不变，防同设备反复换地址
  const ip = rawIp.includes(':') ? 'v6:' + rawIp.split(':').slice(0, 4).join(':') : rawIp;
  const did = (request.headers.get('X-Device-Id') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (rateLimited(ip)) return json({ error: { message: '请求过于频繁，请稍后再试。' } }, 429, cors);

  const code = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const authed = !!code && code === env.INVITE_CODE;
  const anonymous = !code;
  // 带了码但不对 → 401；完全不带码 → 匿名免费额度通道（每 IP 限 FREE_LIMIT 次）
  if (!authed && !anonymous) {
    return json({ error: { message: '邀请码无效：请点右上角「登录」输入邀请码，或在设置里使用自己的 API Key。' } }, 401, cors);
  }

  const url = new URL(request.url);

  // 免费额度查询（只读不计数）：邀请码登录态返回 unlimited，匿名返回剩余次数
  if (request.method === 'GET' && url.pathname === '/v1/quota') {
    const q = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (q && q === env.INVITE_CODE) return json({ unlimited: true }, 200, cors);
    if (!env.FREE_KV) return json({ error: { message: '免费额度未配置' } }, 404, cors);
    const didQ = (request.headers.get('X-Device-Id') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const usedIp = await freeGet(env, ip);
    const usedDev = didQ ? await freeGet(env, 'dev:' + didQ) : 0;
    const used = Math.max(usedIp, usedDev);
    return json({ limit: FREE_LIMIT, used, remaining: Math.max(0, FREE_LIMIT - used) }, 200, cors);
  }

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    return json({ object: 'list', data: [{ id: UPSTREAM_MODEL, object: 'model' }] }, 200, cors);
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (!authed) {
      if (!env.MINIMAX_API_KEY || !env.FREE_KV) {
        return json({ error: { message: '邀请码无效：请点右上角「登录」输入邀请码，或在设置里使用自己的 API Key。' } }, 401, cors);
      }
      const usedIp = await freeGet(env, ip);
      const usedDev = did ? await freeGet(env, 'dev:' + did) : 0;
      const used = Math.max(usedIp, usedDev);
      if (used >= FREE_LIMIT) {
        return json({ error: { message: '本 IP/本设备的 ' + FREE_LIMIT + ' 次免费批改额度已用完（180 天后重置）。可在设置里换成自己的 API Key 继续使用。' } }, 429, cors);
      }
      const dayUsed = await dailyGet(env);
      if (dayUsed >= ANON_DAILY_CAP) {
        return json({ error: { message: '今日全站免费体验额度已被领完（每日 ' + ANON_DAILY_CAP + ' 次），明天 0 点后再来，或在设置里使用自己的 API Key。' } }, 429, cors);
      }
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: { message: '请求过大（上限 20MB）。' } }, 413, cors);
    // 注入深度推理：reasoning_effort='high'（max 会被 CF 524 掐断；客户端显式给定值优先）
    let payload;
    try { payload = JSON.parse(raw); } catch { return json({ error: { message: '请求体不是合法 JSON。' } }, 400, cors); }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.reasoning_effort === undefined) {
      payload.reasoning_effort = 'high';
    }
    const resp = await fetch(UPSTREAM_BASE.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.MINIMAX_API_KEY },
      body: JSON.stringify(payload),
    });
    const headers = { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', ...cors };
    // 匿名成功调用才计数，并在响应头里带回剩余次数
    if (!authed && resp.status === 200) {
      await freeBump(env, ip);
      if (did) await freeBump(env, 'dev:' + did);
      await dailyBump(env);
      const usedIp = await freeGet(env, ip);
      const usedDev = did ? await freeGet(env, 'dev:' + did) : 0;
      headers['X-Free-Remaining'] = String(Math.max(0, FREE_LIMIT - Math.max(usedIp, usedDev)));
    }
    return new Response(resp.body, {
      status: resp.status,
      headers,
    });
  }

  return json({ error: { message: 'Not Found' } }, 404, cors);
}
