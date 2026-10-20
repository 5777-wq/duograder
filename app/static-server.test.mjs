// 桌面壳静态服务器回归测试：node app/static-server.test.mjs
//
// 守住这轮修掉的三件事：
//   · 本地 HTTP 口不再暴露 .git/ 与 data/（用户所有批改记录）
//   · 路径守卫不被同前缀兄弟目录绕过（旧的 startsWith(ROOT) 前缀判断可被绕过）
//   · 非法百分号编码不再让主进程崩溃
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveSafePath, hostAllowed, ALLOW_DIRS } = require('./static-server.cjs');

let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : `  → ${extra}`));
  if (!cond) failed++;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel) => resolveSafePath(ROOT, rel);

console.log('白名单：只暴露 app/ 与 skill/');
ok('白名单内容正确', JSON.stringify(ALLOW_DIRS) === JSON.stringify(['app', 'skill']), ALLOW_DIRS.join(','));
ok('app/ 可读', !!p('/app/index.html'));
ok('skill/ 可读（页面用 ../skill/… 相对路径加载评分规则）', !!p('/skill/kaoyan-essay/SKILL.md'));

console.log('敏感目录不可读');
ok('.git/ 被拒', p('/.git/config') === null);
ok('.git/ 编码绕过也被拒', p('/%2Egit/config') === null);
ok('data/（用户批改记录）被拒', p('/data/real-essay/final.json') === null);
ok('根目录任意文件被拒', p('/README.md') === null);
ok('.env 被拒', p('/.env') === null);
ok('node_modules 被拒', p('/node_modules/anything') === null);

console.log('路径穿越');
ok('向上穿越被拒', p('/app/../../../../Windows/win.ini') === null);
ok('同前缀兄弟目录被拒（前缀判断曾可绕过）', p('/../duograder-secrets/keys.txt') === null);
ok('URL 编码穿越被拒', p('/%2e%2e%2f%2e%2e%2fWindows%2fwin.ini') === null);
ok('null 字节被拒', p('/app/index.html%00.png') === null);

console.log('崩溃防护');
ok('非法百分号编码返回 null（不抛异常）', p('/%') === null);
ok('非法百分号编码不崩（第二次同样安全）', p('/%E0%A4%A') === null);

console.log('Host 校验（防 DNS rebinding）');
ok('本机 Host 放行', hostAllowed('127.0.0.1:54321') === true);
ok('localhost 放行', hostAllowed('localhost:8080') === true);
ok('无 Host 放行', hostAllowed('') === true);
ok('外部域名被拒', hostAllowed('evil.example.com') === false);
ok('伪造 IP Host 被拒', hostAllowed('127.0.0.1.evil.com') === false);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
