// DuoGrader 邀请码代理 · Pages Functions 入口
// 与网页同域（duograder.pages.dev/v1/*），国内可直连（workers.dev 被墙时的主路径）。
//
// 真正的实现放在共享内核 proxy/proxy-core.js（单一真源），本文件只做入口适配：
// Pages Functions 的调用约定是 onRequest({ request, env })，Workers 是 fetch(request, env)。
// 副本由 scripts/sync_app.py 从真源同步到本目录的 _proxy-core.js，CI 断言二者逐字节一致。
//
// 安全设计：上游地址写死；key 只存 Pages 加密 secret（wrangler pages secret put）；
// 不转发客户端原始头；CORS 白名单只放行本应用来源；匿名通道有免费额度配额。

import { handleProxy } from './_proxy-core.js';

export async function onRequest({ request, env }) {
  return handleProxy(request, env);
}
