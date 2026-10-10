// DuoGrader 邀请码代理（Cloudflare Worker）
// 无存储纯转发：校验邀请码 → 注入真实 key → 转发 MiniMax。
// 安全设计：上游地址写死（客户端无法指定目标）；key 只存在 Workers 加密 secret；
// 不转发客户端原始头（重新构造）；不打印请求体；CORS 白名单只放行本应用来源。

const CORS_SUFFIX = '.duograder.pages.dev';
const MAX_BODY = 20 * 1024 * 1024; // 8 张照片 base64 也够用

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed =
    origin === 'https://duograder.pages.dev' ||
    (origin.endsWith(CORS_SUFFIX) && /^https:\/\/[a-z0-9-]+\.duograder\.pages\.dev$/.test(origin)) ||
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

// 尽力而为限速：每 isolate 内存滑窗（实例重启即清零，是第一道闸不是精确计量）
function rateLimited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 120;
  const buckets = (globalThis.__rl ||= new Map());
  const arr = (buckets.get(ip) || []).filter((t) => now - t < win);
  const limited = arr.length >= max;
  if (!limited) arr.push(now);
  buckets.set(ip, arr);
  return limited;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) return json({ error: { message: '请求过于频繁，请稍后再试。' } }, 429, cors);

    // 鉴权：前端复用 apiKey 字段传邀请码（Authorization: Bearer <邀请码>）
    const code = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!code || code !== env.INVITE_CODE) {
      return json({ error: { message: '邀请码无效：请点右上角「登录」输入邀请码，或在设置里使用自己的 API Key。' } }, 401, cors);
    }

    const url = new URL(request.url);

    // 型号清单不打上游，直接回报内置型号（供前端"拉取模型/诊断"链路）
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      const ids = [...new Set([env.UPSTREAM_MODEL, env.UPSTREAM_VISION_MODEL].filter(Boolean))];
      return json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }, 200, cors);
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ error: { message: '请求过大（上限 20MB）。' } }, 413, cors);
      // 注入最高推理强度：MiniMax 官方参数 reasoning_effort，档位最高为 "max"。
      // 客户端显式给定的值优先；批改这类结构化任务吃推理深度，代理侧统一开满。
      let payload;
      try { payload = JSON.parse(raw); } catch { return json({ error: { message: '请求体不是合法 JSON。' } }, 400, cors); }
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.reasoning_effort === undefined) {
        payload.reasoning_effort = 'max';
      }
      const upstream = env.UPSTREAM_BASE.replace(/\/+$/, '') + '/chat/completions';
      const resp = await fetch(upstream, {
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
  },
};
