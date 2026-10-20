// DuoGrader 邀请码代理 · Cloudflare Worker 入口
//
// 真正的实现放在共享内核 proxy/proxy-core.js（单一真源），本文件只做入口适配：
// Workers 的调用约定是 fetch(request, env)，Pages Functions 是 onRequest({ request, env })。
// 副本由 scripts/sync_app.py 从真源同步到本目录的 _proxy-core.js，CI 断言二者逐字节一致。
//
// 安全设计：上游地址写死（客户端无法指定目标）；key 只存 Workers 加密 secret；
// 不转发客户端原始头（重新构造）；CORS 白名单只放行本应用来源。

import { handleProxy } from './_proxy-core.js';

export default {
  async fetch(request, env) {
    return handleProxy(request, env);
  },
};
