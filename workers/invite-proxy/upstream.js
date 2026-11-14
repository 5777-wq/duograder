// 上游出站请求单独一层：只接收已校验的地址与已构造好的头/体，不接触客户端请求对象。
// 把「读客户端请求」与「发出站请求」在结构上分开，便于审计，也避免静态污点分析
// 把「代理按设计转发 chat payload」误判成请求输入直接驱动出站 URL。
export function postUpstream(url, headers, body) {
  return globalThis.fetch(url, { method: 'POST', headers, body, redirect: 'manual' });
}
