// DuoGrader 桌面壳（Electron）：内置静态服务器（保持 ../skill 规则相对路径可用）+ 窗口
const { app, BrowserWindow, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // duograder 仓库根目录
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let fp = path.normalize(path.join(ROOT, urlPath));
      if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      if (urlPath === '/' || urlPath === '') fp = path.join(ROOT, 'app', 'index.html');
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function createWindow() {
  const srv = await startServer();
  const port = srv.address().port;
  const win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 960, minHeight: 640,
    title: 'DuoGrader · 双评阅卷官',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f0eee6',
    autoHideMenuBar: true,
    webPreferences: {
      // 自用本地应用：放开跨域限制，任意供应商 API 都可直连（等价于浏览器加 CORS 插件）
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}/app/`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
