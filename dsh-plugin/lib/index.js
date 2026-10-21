/**
 * DuoGrader for DeepSeek Harness —— 宿主半侧入口。
 *
 * 本插件不重新实现评分逻辑：它把仓库根的 skill/（唯一真源，由
 * scripts/sync_app.py 同步到 assets/）注册为一个内置 skill 提供方。
 * 因此模型通过 DSH 原生的 `skill` 工具加载 kaoyan-essay，
 * 而 DSH 原生的 subagent（spawn provider）天然满足双盲隔离要求。
 *
 * @module dsh-duograder
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PROVIDER_NAME = "duograder";
const SKILL_NAME = "kaoyan-essay";

/** assets/ 目录——同步后的 skill 快照，是加载时的资源基底。 */
const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));
const SKILL_ROOT = join(ASSETS_DIR, SKILL_NAME);
const SKILL_BODY_PATH = join(SKILL_ROOT, "SKILL.md");
const SKILL_BODY_URL = new URL(`../assets/${SKILL_NAME}/SKILL.md`, import.meta.url);

const RESOURCE_BASE = { kind: "directory", path: SKILL_ROOT };
const INVOCATION = { modelInvocable: true, userInvocable: true };

/** 从 SKILL.md 的 YAML frontmatter 里读 name/description，避免两处维护。 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) throw new Error("dsh-duograder: SKILL.md 缺少 YAML frontmatter");
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return meta;
}

/**
 * 目录条目缓存。DSH 注册表按 revision 缓存快照，但 list() 仍可能被多次调用；
 * 这里只缓存 frontmatter 元数据（正文永远按需重读，与 dsh-skill 的
 * 「定义从不缓存」约定一致）。
 */
let metaCache;

async function loadMeta() {
  if (metaCache) return metaCache;
  const body = await readFile(SKILL_BODY_PATH, "utf8");
  const fm = parseFrontmatter(body);
  metaCache = {
    name: fm.name ?? SKILL_NAME,
    description:
      fm.description ??
      "考研英语作文双评批改（DuoGrader）。两位阅卷员独立盲评 + 分差仲裁 + 逐句精改。",
  };
  return metaCache;
}

const provider = {
  name: PROVIDER_NAME,
  async list() {
    const meta = await loadMeta();
    return [
      {
        name: meta.name,
        description: meta.description,
        invocation: INVOCATION,
        provider: PROVIDER_NAME,
        source: "bundled",
        resourceBase: RESOURCE_BASE,
        rank: 600,
        locator: SKILL_BODY_URL,
      },
    ];
  },
  async get(candidate) {
    const meta = await loadMeta();
    return {
      name: meta.name,
      description: meta.description,
      invocation: INVOCATION,
      provider: PROVIDER_NAME,
      source: "bundled",
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_PATH, "utf8"),
    };
  },
};

/** Cordis 插件名。 */
const name = "duograder";
/** 依赖 skill 注册表。 */
const inject = ["skills"];

/** 注册内置 skill 提供方。 */
function apply(ctx) {
  ctx.skills.registerProvider(() => provider);
}

export { apply, inject, name, provider, parseFrontmatter };
