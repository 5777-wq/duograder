// DuoGrader 本地静态服务器（桌面壳用）
//
// 单独成模块、不依赖 electron，是为了让安全相关的路径守卫能在普通 Node 里被测试覆盖。
//
// 安全设计：
//   · 只暴露 ALLOW_DIRS 里的子树：app/ 是页面本体，skill/ 是评分规则（页面用 ../skill/… 相对路径加载）。
//     早期版本以仓库根为服务根，会把 .git/ 与 data/（用户所有批改记录）一并暴露在本地 HTTP 口上。
//   · 路径守卫按路径分量判断，不用字符串前缀（startsWith(ROOT) 会被同前缀兄弟目录绕过）。
//   · 非法百分号编码不再抛未捕获异常（早期版本一个 /% 请求就能崩掉主进程）。
//   · 校验 Host 头，防 DNS rebinding：只接受 127.0.0.1/localhost + 实际端口。
const http = require('http');
const fs = require('fs');
const path = require('path');

// 开发态（仓库根为服务根）：只暴露 app/ 与 skill/ 两个子树
const DEV_ALLOW_DIRS = ['app', 'skill'];
// 打包态（asar 根为服务根）：页面文件直接在根上，额外放行这些文件
const PACKAGED_ROOT_FILES = new Set([
  'index.html', 'ui.js', 'core.js', 'style.css', 'sw.js',
  'logo.svg', 'icon.png', 'icon-192.png', 'manifest.json',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// 把 URL 路径解析成服务根内的真实文件；越界 / 不在白名单 / 编码非法则返回 null
function resolveSafePath(root, urlPath, opts = {}) {
  const allowDirs = opts.allowDirs || DEV_ALLOW_DIRS;
  const rootFiles = opts.rootFiles || null;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // 非法百分号编码
  }
  if (decoded.includes('\0')) return null;
  const fp = path.normalize(path.join(root, decoded));
  // 按路径分量判断：相对路径不得以 .. 开头，也不得跳到绝对路径
  const rel = path.relative(root, fp);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length === 1) {
    // 根级文件：打包态放行固定清单，开发态一律不放行
    if (rootFiles && rootFiles.has(parts[0])) return fp;
    return null;
  }
  if (!allowDirs.includes(parts[0])) return null;
  return fp;
}

function hostAllowed(host) {
  if (!host) return true; // 没有 Host 的请求（如原生 HTTP/1.0 客户端）放行到下一层判断
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

function createStaticServer(root, opts = {}) {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = new URL(req.url, 'http://x').pathname;
    } catch {
      res.writeHead(400); return res.end();
    }
    if (!hostAllowed(String(req.headers.host || ''))) {
      res.writeHead(403); return res.end();
    }
    if (urlPath === '/' || urlPath === '') urlPath = opts.indexPath || '/app/index.html';
    const fp = resolveSafePath(root, urlPath, opts);
    if (!fp) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

module.exports = { DEV_ALLOW_DIRS, PACKAGED_ROOT_FILES, MIME, resolveSafePath, hostAllowed, createStaticServer };
