// DuoGrader Service Worker · 把网页变成真 App 壳
//
// 策略：同源 GET 一律「网络优先，失败回落缓存」
//   · 在线时永远拿到最新代码（部署即生效，不会被旧缓存卡住）
//   · 离线/弱网时仍能打开应用壳，本地历史（IndexedDB）照常看得见
//
// 范围说明：本 SW 注册在 /app/ 下，只接管应用壳自身的资源。
// 评分规则（/skill/…）不在范围内 —— 但它只在"批改"时需要，而批改本来就得联网，
// 所以离线时看不到规则不影响"看历史"。离线降级由 init() 的提示负责。
//
// 换版本：改 VERSION 即可。sw.js 字节一变，浏览器就会装新 SW 并清掉旧缓存。

const VERSION = 'v1';
const CACHE = 'duograder-' + VERSION;

// 应用壳：离线时必须能打开
const SHELL = [
  './', './index.html', './ui.js', './core.js', './style.css',
  './logo.svg', './icon-192.png', './icon.png', './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个 add：单个资源 404 不该让整次安装失败
    await Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('duograder-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // 模型请求是 POST，本就不该缓存
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;      // 供应商 API 不碰

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        const c = await caches.open(CACHE);
        c.put(req, res.clone()).catch(() => {});        // 缓存失败无所谓，本次已经拿到
      }
      return res;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('当前离线，且这个资源没有缓存。', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
