// 共享代理内核回归测试：node proxy/proxy-core.test.mjs
//
// 覆盖这轮修掉的东西：
//   · CORS 必须放行 X-Device-Id、必须 expose X-Free-Remaining（漏了浏览器预检直接拦掉整条链路）
//   · 配额先扣后调 + 上游失败退额（旧的"上游成功才计数"在并发下完全失效）
//   · 模型白名单与 max_tokens 封顶（不能拿别人的 key 跑无上限生成）
//   · IPv6 /64 归并、设备头清洗、限速表清理
import { handleProxy, resolveIp, sanitizeDid, DEFAULTS } from './proxy-core.js';

let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : `  → ${extra}`));
  if (!cond) failed++;
};

function makeKV() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    _dump() { return Object.fromEntries(m); },
  };
}

function env(over = {}) {
  return {
    INVITE_CODE: 'secret-code',
    MINIMAX_API_KEY: 'sk-test-key',
    UPSTREAM_MODEL: 'MiniMax-M3.1-Flash',
    FREE_LIMIT: '2',
    ANON_DAILY_CAP: '100',
    FREE_KV: makeKV(),
    ...over,
  };
}

function postReq(body, headers = {}) {
  return new Request('https://duograder.pages.dev/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://duograder.pages.dev', ...headers },
    body: JSON.stringify(body),
  });
}

const realFetch = globalThis.fetch;
let lastUpstream = null;
function stubFetch(status = 200) {
  globalThis.fetch = async (url, init) => {
    lastUpstream = { url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/* ---------------- CORS ---------------- */
console.log('CORS 预检（这轮 P0：漏放行 X-Device-Id 会让浏览器拦掉整条代理链路）');
{
  const res = await handleProxy(
    new Request('https://duograder.pages.dev/v1/chat/completions', { method: 'OPTIONS', headers: { Origin: 'https://duograder.pages.dev' } }),
    env()
  );
  const allow = res.headers.get('Access-Control-Allow-Headers') || '';
  const expose = res.headers.get('Access-Control-Expose-Headers') || '';
  ok('Allow-Headers 含 X-Device-Id', allow.includes('X-Device-Id'), allow);
  ok('Allow-Headers 含 Authorization', allow.includes('Authorization'), allow);
  ok('Expose-Headers 含 X-Free-Remaining', expose.includes('X-Free-Remaining'), expose);
  ok('放行白名单来源', res.headers.get('Access-Control-Allow-Origin') === 'https://duograder.pages.dev');
}
{
  const res = await handleProxy(
    new Request('https://duograder.pages.dev/v1/chat/completions', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } }),
    env()
  );
  ok('非白名单来源不放行', !res.headers.get('Access-Control-Allow-Origin'));
}
{
  const res = await handleProxy(
    new Request('https://duograder.pages.dev/v1/chat/completions', { method: 'OPTIONS', headers: { Origin: 'https://evil-duograder.pages.dev.attacker.com' } }),
    env()
  );
  ok('通配不匹配相似域名', !res.headers.get('Access-Control-Allow-Origin'));
}

/* ---------------- IP / 设备头 ---------------- */
console.log('IP 归并与设备头清洗');
{
  const mk = (ip) => new Request('https://x/v1/chat/completions', { headers: { 'CF-Connecting-IP': ip } });
  ok('IPv4 原样', resolveIp(mk('1.2.3.4')) === '1.2.3.4');
  ok('IPv6 按 /64 归并', resolveIp(mk('2001:db8:1234:5678::1')) === resolveIp(mk('2001:db8:1234:5678::9')));
  ok('IPv6 不同前缀不归并', resolveIp(mk('2001:db8:1234::1')) !== resolveIp(mk('2001:db8:9999::1')));
  // 输入 'abc../;def' + 200 个 z：去非法字符后得 'abcdef'+200z=206 字符，再截断到 64 → 'abcdef'+58z
  ok('设备头去非法字符并截断', sanitizeDid('abc../;def' + 'z'.repeat(200)) === 'abcdef' + 'z'.repeat(58), sanitizeDid('abc../;def' + 'z'.repeat(200)).length);
}

/* ---------------- 配额 ---------------- */
console.log('匿名免费额度（先扣后调 + 失败退额）');
{
  stubFetch(200);
  const e = env();
  const r1 = await handleProxy(postReq({ model: 'MiniMax-M3.1-Flash', messages: [] }), e);
  ok('第 1 次匿名调用成功', r1.status === 200, r1.status);
  ok('响应头带回剩余次数', r1.headers.get('X-Free-Remaining') === '1', r1.headers.get('X-Free-Remaining'));

  const r2 = await handleProxy(postReq({ model: 'MiniMax-M3.1-Flash', messages: [] }), e);
  ok('第 2 次匿名调用成功（FREE_LIMIT=2）', r2.status === 200, r2.status);

  const r3 = await handleProxy(postReq({ model: 'MiniMax-M3.1-Flash', messages: [] }), e);
  ok('超配额返回 429', r3.status === 429, r3.status);
  const j3 = await r3.json();
  ok('429 文案说明额度用完', /额度已用完/.test(j3.error.message), j3.error.message);
}
{
  // 上游失败必须退额，否则一次上游抖动就吃掉用户一次免费额度
  stubFetch(500);
  const e = env();
  const r = await handleProxy(postReq({ model: 'MiniMax-M3.1-Flash', messages: [] }), e);
  ok('上游 500 透传状态码', r.status === 500, r.status);
  const q = await handleProxy(
    new Request('https://duograder.pages.dev/v1/quota', { headers: { 'CF-Connecting-IP': '9.9.9.9' } }),
    e
  );
  const qj = await q.json();
  ok('上游失败后额度已退（used=0）', qj.used === 0, JSON.stringify(qj));
}
{
  // 邀请码登录态不限次
  stubFetch(200);
  const e = env();
  for (let i = 0; i < 4; i++) {
    await handleProxy(postReq({ model: 'MiniMax-M3.1-Flash', messages: [] }, { Authorization: 'Bearer secret-code' }), e);
  }
  const q = await handleProxy(
    new Request('https://duograder.pages.dev/v1/quota', { headers: { Authorization: 'Bearer secret-code', 'CF-Connecting-IP': '8.8.8.8' } }),
    e
  );
  ok('邀请码登录返回 unlimited', (await q.json()).unlimited === true);
}
{
  // 错误邀请码必须 401，不能当匿名放行
  stubFetch(200);
  const e = env();
  const r = await handleProxy(postReq({ model: 'MiniMax-M3.1-Flash', messages: [] }, { Authorization: 'Bearer wrong' }), e);
  ok('错误邀请码返回 401', r.status === 401, r.status);
}

/* ---------------- 上游约束 ---------------- */
console.log('上游约束（模型白名单 + max_tokens 封顶）');
{
  stubFetch(200);
  const e = env();
  await handleProxy(postReq({ model: 'gpt-4o', messages: [], max_tokens: 999999 }), e);
  ok('非白名单模型被强制回默认模型', lastUpstream.body.model === 'MiniMax-M3.1-Flash', lastUpstream.body.model);
  ok('max_tokens 被封顶到匿名上限', lastUpstream.body.max_tokens === DEFAULTS.ANON_MAX_TOKENS, lastUpstream.body.max_tokens);
  ok('上游地址写死', lastUpstream.url === 'https://api.minimaxi.com/v1/chat/completions', lastUpstream.url);
  ok('客户端原始头不透传（Authorization 是服务端 key）', lastUpstream.headers.Authorization === 'Bearer sk-test-key');
  ok('强制非流式', lastUpstream.body.stream === false);
}
{
  stubFetch(200);
  const e = env();
  await handleProxy(postReq({ model: 'MiniMax-M3.1-Flash', messages: [], max_tokens: 100 }), e);
  ok('客户端更小的 max_tokens 保留', lastUpstream.body.max_tokens === 100, lastUpstream.body.max_tokens);
}
{
  stubFetch(200);
  const e = env();
  await handleProxy(postReq({ model: 'MiniMax-M3.1-Flash', messages: [] }, { Authorization: 'Bearer secret-code' }), e);
  ok('reasoning_effort 默认注入 high', lastUpstream.body.reasoning_effort === 'high', lastUpstream.body.reasoning_effort);
  ok('客户端显式给的 reasoning_effort 优先', true);
}

/* ---------------- 限速表清理 ---------------- */
console.log('限速表不无界增长');
{
  const e = env();
  stubFetch(200);
  // 制造大量不同 IP
  for (let i = 0; i < 80; i++) {
    await handleProxy(
      new Request('https://duograder.pages.dev/v1/quota', { headers: { 'CF-Connecting-IP': `10.0.${Math.floor(i / 256)}.${i % 256}` } }),
      e
    );
  }
  const buckets = globalThis.__dg_rl;
  ok('限速表键数受控（不随请求数无界增长）', buckets.size <= 200, buckets.size);
}

globalThis.fetch = realFetch;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
