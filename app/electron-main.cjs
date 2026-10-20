// DuoGrader 桌面壳（Electron）：内置静态服务器 + 窗口
//
// 静态服务器与路径守卫在 app/static-server.cjs（无 electron 依赖，可被 node 直接测试：
// 见 app/static-server.test.mjs）。这里只负责起服务、开窗口。
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { createStaticServer } = require('./static-server.cjs');

const ROOT = path.join(__dirname, '..'); // duograder 仓库根目录

function startServer() {
  return new Promise((resolve) => {
    const srv = createStaticServer(ROOT);
    srv.on('error', (e) => { console.error('local server error:', e && e.message); });
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
      // 自用本地应用：放开跨域限制，任意供应商 API 都可直连（等价于浏览器加 CORS 插件）。
      // 本地服务器只暴露 app/ 与 skill/，因此这条放宽不会连带暴露仓库里的其它数据。
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
