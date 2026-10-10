// DuoGrader 邀请码代理 · Pages Functions 版
// 与网页同域（duograder.pages.dev/v1/*），国内可直连（workers.dev 被墙时的主路径）。
// 安全设计与 workers/invite-proxy/worker.js 完全一致：
// 无存储纯转发；上游写死；key 只存 Pages 加密 secret（wrangler pages secret put）；
// 不转发客户端原始头；CORS 白名单只放行本应用来源。

const UPSTREAM_BASE = 'https://api.minimaxi.com/v1';
const UPSTREAM_MODEL = 'MiniMax-M3.1-Flash-Preview';
const MAX_BODY = 20 * 1024 * 1024;

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

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) return json({ error: { message: '请求过于频繁，请稍后再试。' } }, 429, cors);

  const code = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!code || code !== env.INVITE_CODE) {
    return json({ error: { message: '邀请码无效：请点右上角「登录」输入邀请码，或在设置里使用自己的 API Key。' } }, 401, cors);
  }

  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    return json({ object: 'list', data: [{ id: UPSTREAM_MODEL, object: 'model' }] }, 200, cors);
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: { message: '请求过大（上限 20MB）。' } }, 413, cors);
    // 注入最高推理强度：MiniMax 官方参数，档位最高为 "max"（客户端显式给定值优先）
    let payload;
    try { payload = JSON.parse(raw); } catch { return json({ error: { message: '请求体不是合法 JSON。' } }, 400, cors); }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.reasoning_effort === undefined) {
      payload.reasoning_effort = 'max';
    }
    const resp = await fetch(UPSTREAM_BASE.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.MINIMAX_API_KEY },
      body: JSON.stringify(payload),
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', ...cors },
    });
  }

  return json({ error: { message: 'Not Found' } }, 404, cors);
}
