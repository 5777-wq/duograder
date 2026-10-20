// DuoGrader 桌面壳（Electron）：内置静态服务器 + 窗口
//
// 两种目录布局：
//   开发态：app/ 在仓库里 → 服务根 = 仓库根，页面在 /app/，评分规则在 /skill/
//   打包态：页面与评分规则都进了 asar → 服务根 = asar 根，页面在 /，规则在 /skill/
// 早期版本只有开发态这一种假设，打包后 __dirname 落在 asar 里、服务根算到 resources/，
// 打出来的 exe 一打开就是 404。
//
// 静态服务器与路径守卫在 app/static-server.cjs（不依赖 electron，可被 node 直接测试：
// 见 app/static-server.test.mjs）。这里只负责起服务、开窗口。
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { createStaticServer, DEV_ALLOW_DIRS, PACKAGED_ROOT_FILES } = require('./static-server.cjs');

const HERE = __dirname;
const DEV_ROOT = path.join(HERE, '..');
// 判定依据：仓库里是否存在 app/app/index.html（存在说明我们在仓库的 app/ 目录里）
const PACKAGED = !fs.existsSync(path.join(DEV_ROOT, 'app', 'index.html'));
const ROOT = PACKAGED ? HERE : DEV_ROOT;
const INDEX_PATH = PACKAGED ? '/index.html' : '/app/index.html';
const SERVER_OPTS = PACKAGED
  ? { allowDirs: ['skill'], rootFiles: PACKAGED_ROOT_FILES, indexPath: INDEX_PATH }
  : { allowDirs: DEV_ALLOW_DIRS, indexPath: INDEX_PATH };

function startServer() {
  return new Promise((resolve) => {
    const srv = createStaticServer(ROOT, SERVER_OPTS);
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
      // 本地服务器只暴露页面与 skill/，因此这条放宽不会连带暴露仓库里的其它数据。
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}${PACKAGED ? '/' : '/app/'}`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
