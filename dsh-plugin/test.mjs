// dsh-duograder 插件的回归测试。
// 守住四件事：清单能被 DSH 认、provider 契约正确、skill 内容齐全、资源路径可解析。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const mod = await import('./lib/index.js');

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};
const ta = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

// ---------- 1. 包清单契约 ----------
t('package name 与 patch 里的 entry id 一致', () => {
  const patch = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  const m = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch);
  assert.ok(m, 'patch 里找不到 id 行');
  assert.equal(m[1], pkg.name, 'patch entry id 必须等于包名（商城上架契约按它比对）');
});

t('patch 的 id 行没有行尾注释', () => {
  const patch = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  for (const line of patch.split(/\r?\n/)) {
    if (/^\s*-\s*id:/.test(line)) {
      assert.ok(/^\s*-\s*id:\s*[^\s#]+\s*$/.test(line),
        `id 行不得带行尾注释（会让商城预检抓不到 entry ID）: ${line}`);
    }
  }
});

t('清单声明了 bundle patch 且文件存在', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(existsSync(join(here, 'cordis.patch.yml')));
});

t('清单声明了 main 且文件存在', () => {
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.main, '缺少 main');
  assert.ok(existsSync(join(here, pkg.main)), `main 文件不存在: ${pkg.main}`);
});

t('compatibility 里有至少一个 compatible', () => {
  const rel = pkg.dsh?.compatibility?.dshReleases ?? {};
  assert.ok(Object.values(rel).includes('compatible'),
    'dshReleases 至少要声明一个 compatible（只写范围不算证据）');
});

t('files 白名单覆盖运行时必需产物', () => {
  const files = pkg.files ?? [];
  for (const need of ['lib', 'assets', 'cordis.patch.yml']) {
    assert.ok(files.includes(need), `files 缺少 ${need}——装到用户机器上会缺文件`);
  }
});

// ---------- 2. Cordis 插件契约 ----------
t('导出 name / inject / apply', () => {
  assert.equal(typeof mod.name, 'string');
  assert.deepEqual(mod.inject, ['skills']);
  assert.equal(typeof mod.apply, 'function');
});

t('apply 会向 ctx.skills 注册 provider', () => {
  let captured = null;
  mod.apply({ skills: { registerProvider: (fn) => { captured = fn(); } } });
  assert.ok(captured, 'registerProvider 未被调用');
  assert.equal(captured.name, 'duograder');
});

// ---------- 3. provider 返回的候选与正文 ----------
await ta('list() 返回合法的 skill 候选', async () => {
  const p = mod.provider;
  const list = await p.list();
  assert.equal(list.length, 1);
  const e = list[0];
  assert.equal(e.name, 'kaoyan-essay');
  assert.match(e.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'skill 名必须是 kebab-case');
  assert.ok(e.description.length > 0, 'description 必填');
  assert.equal(e.provider, 'duograder');
  assert.equal(e.resourceBase.kind, 'directory');
  assert.ok(e.resourceBase.path.length > 0);
  assert.equal(typeof e.invocation?.modelInvocable, 'boolean');
  assert.equal(typeof e.invocation?.userInvocable, 'boolean');
});

await ta('get() 返回正文且 frontmatter 可解析', async () => {
  const p = mod.provider;
  const [e] = await p.list();
  const got = await p.get(e);
  assert.equal(got.name, 'kaoyan-essay');
  assert.ok(got.content.length > 1000, '正文过短，可能没读到文件');
  assert.ok(got.content.startsWith('---'), '正文应以 YAML frontmatter 开头');
  const fm = mod.parseFrontmatter(got.content);
  assert.equal(fm.name, 'kaoyan-essay');
  assert.ok(fm.description.length > 0);
});

await ta('frontmatter 缺 name 时报错而不是静默放行', async () => {
  assert.throws(() => mod.parseFrontmatter('# 没有 frontmatter\n正文'), /frontmatter/);
});

await ta('list() 的 name/description 与正文 frontmatter 一致', async () => {
  const p = mod.provider;
  const [e] = await p.list();
  const got = await p.get(e);
  const fm = mod.parseFrontmatter(got.content);
  assert.equal(e.name, fm.name);
  assert.equal(e.description, fm.description);
});

// ---------- 4. 随包资源完整性 ----------
await ta('资源基目录下 skill 四件套齐全', async () => {
  const [e] = await mod.provider.list();
  const base = e.resourceBase.path;
  for (const rel of [
    'SKILL.md',
    'rubrics/writing-rubric.md',
    'schema/grading-report.schema.json',
    'scripts/precheck.py',
    'scripts/validate_report.py',
    'scripts/average_reports.py',
    'references/past-prompts-index.md',
    'prompts/grader-task.md',
    'prompts/arbiter-task.md',
  ]) {
    assert.ok(existsSync(join(base, rel)), `随包资源缺失: ${rel}`);
  }
});

await ta('schema 是合法 JSON 且含必填字段', async () => {
  const [e] = await mod.provider.list();
  const schema = JSON.parse(
    readFileSync(join(e.resourceBase.path, 'schema/grading-report.schema.json'), 'utf8'));
  assert.equal(typeof schema, 'object');
  assert.ok(schema.required?.length > 0, 'schema 应有 required 列表');
});

await ta('随包资源不含 __pycache__ / .pyc', async () => {
  const [e] = await mod.provider.list();
  const base = e.resourceBase.path;
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      assert.ok(!ent.name.endsWith('.pyc'), `不该随包分发字节码: ${full}`);
      assert.ok(ent.name !== '__pycache__', `不该随包分发 __pycache__: ${full}`);
      if (ent.isDirectory()) walk(full);
    }
  };
  if (existsSync(base)) walk(base);
});


console.log(`\ndsh-duograder: ${pass} 项断言通过`);
