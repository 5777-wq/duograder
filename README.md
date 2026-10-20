<div align="center">

<img src="docs/assets/logo.svg" width="76" alt="DuoGrader">

# DuoGrader · 双评阅卷官

**像真实考研阅卷一样批改你的英语作文**

两位 AI 阅卷员独立盲评 · 分差仲裁 · 逐句精改 · 确定性预检
自带 API Key 免会员；也可用邀请码走内置算力

[![CI](https://github.com/5777-wq/duograder/actions/workflows/ci.yml/badge.svg)](https://github.com/5777-wq/duograder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fduograder.pages.dev%2Fapp%2F&label=%E5%AE%98%E7%BD%91)](https://duograder.pages.dev/app/)

**🌐 [在线使用 · 无需安装](https://duograder.pages.dev/app/)**　|　📱 [安卓 App](https://github.com/5777-wq/duograder/releases/latest/download/DuoGrader.apk)　|　🤖 [Agent Skill](#-agent-skill)

![真实批改报告](docs/assets/report-preview.png)

*一次真实批改的终裁报告：双评过程、维度拆解、三级逐句批改、可执行训练建议*

</div>

---

## 为什么是「双评」

单次 LLM 打分的顽疾：**同一篇作文，评两次能差出一个档位**——分数飘、把对的改错、字数靠猜。DuoGrader 的判断是：瓶颈不在模型，在评分流程。所以我们把真实考研阅卷的制度搬了过来：

| 单次提问的老毛病 | DuoGrader 的对策 |
|---|---|
| 分数会飘，评两次差一档 | **双盲双评**：两位阅卷员独立请求、互不可见；同档取均值，差档仲裁员依档位描述强制二选一 |
| 把对的改错、过度润色 | **三级错误分级**：error 扣分 / awkward 提示 / style 仅润色；拿不准一律降级，宁漏勿冤 |
| 字数数不对、格式看不见 | **确定性预检**：字数、段落、格式由脚本计算，评分者只准引用、禁止自算 |
| 报告自相矛盾无人发现 | **机器校验**：维度分之和必须落在档位区间内，不达标自动打回重评 |

效果有数：同一篇作文 3 轮双评**档位零波动**；12 颗预植错误的句级查全率 **100%**、误报 **0**；35 处逐句批改人工审计**把对的改错 = 0**。全部实验记录公开在 [`docs/validation/`](docs/validation/)，失败照报。

## 四种用法

**🌐 网页 / 手机（推荐，零安装）**
打开 [duograder.pages.dev/app](https://duograder.pages.dev/app/) → 设置里选供应商、填 API Key →「一键诊断」四项全绿 → 拍照或拖入作文 → 核对 AI 转写 → 双评。手机浏览器打开后"添加到主屏幕"即是全屏 App。

**📦 安卓 App**
直接下载 [最新版 APK](https://github.com/5777-wq/duograder/releases/latest/download/DuoGrader.apk)（安装需允许未知来源）。原生壳为 Capacitor，源码在本仓 `android/`；推送 `app/` 或 `android/` 变更后 CI（apk.yml）自动构建，也可 GitHub 页面手动触发。无跨域限制，任意供应商可直连。

**🖥️ 桌面壳（Electron）**
```bash
cd app && npm ci && npm start
```
自用本地应用：内置静态服务器 + 放开渲染进程跨域限制，**任意供应商 API 都能直连**（不用再装浏览器 CORS 插件）。本地服务器只暴露 `app/` 与 `skill/` 两个子树，仓库里的 `.git/`、`data/`（你的批改记录）都在射程之外。

**🤖 [Agent Skill](#-agent-skill)**

## 🤖 Agent Skill

适用于 Codex / Claude Code / ZCode 等支持 skill 的 agent：

```bash
git clone https://github.com/5777-wq/duograder.git
```

把仓库交给你的 agent，说："读取 `skill/kaoyan-essay/SKILL.md` 并按其执行：批改这篇考研英语作文"。宿主将自动完成预检、双盲评分、机器校验与仲裁。

内核本身是**宿主无关**的：`SKILL.md`（带标准 frontmatter）+ 评分规则 + 输出契约 + 版本化提示词 + 确定性脚本，五件套齐备，不绑定任何具体 provider。

> ⚠️ **一个诚实的限制**：双盲的全部价值在于两位阅卷员互不可见。SKILL.md 第 4 步靠"并行派出两个独立 subagent"实现这一点——需要宿主支持 subagent。宿主不支持时按 SKILL.md 的降级条款由单上下文做两轮自评，**独立性弱于标准流程**，报告会明确标注。把"双盲执行"下沉到宿主之外（例如做成 MCP 工具，由服务端发两次互不可见的请求）是彻底解法，属下一步工作。

> 💰 **成本**：一次完整批改 = 3 次模型调用（双评 + 可能的仲裁）。按 DeepSeek / GLM 计价约一两分钱，一个备考季花不了一顿早饭。

## 工作原理

```
题面 + 作文 + 预检事实
        │
   ┌────┴────┐
   ▼         ▼          两次独立请求，互相看不到对方
 阅卷员 A   阅卷员 B     （同一 Key 同一模型即可，无需两个账号）
   └────┬────┘
        ▼
   同档 → 脚本均值合并（确定性算术）
   差一档 → 仲裁员引用档位描述强制二选一
   差两档 → 判定失效，自动重评
        ▼
   终裁报告：维度表 / 逐句批改 / 修改版 / 训练建议
```

报告头部的**双评汇聚尺**把这个过程画出来：两位阅卷员的初评与终裁分落在同一条 0..满分 刻度上——同档时两个刻点垂直对齐（均值合并），差一档时刻点分离、终裁精确落在被采信的一方。不用读说明文字，一眼就知道这一分是怎么来的。

**同档合并由脚本执行，档位之争才交给仲裁员**——这条边界必须严守：仲裁协议是"差一档二选一"，若把"同档但维度口径对不齐"也丢给仲裁员，等于整份挑一份，把确定性均值合并的稳定性丢掉了。分流规则写在 `scripts/average_reports.py` 的退出码里：
| 退出码 | 含义 | 下一步 |
|---|---|---|
| 0 | 合并成功 | 直接渲染终裁报告 |
| 2 | 档位不一致 / 合并后越界 | 派仲裁员 |
| 3 | 两位阅卷员维度集合对不齐 | 打回重评，**不仲裁** |

网页端走的是同一套规则（`app/core.js` 的 `mergeSameBand`），两条路径的结论由 CI 断言强制一致。

## 核心资产

| 位置 | 是什么 |
|---|---|
| [`skill/kaoyan-essay/rubrics/writing-rubric.md`](skill/kaoyan-essay/rubrics/writing-rubric.md) | 官方五档评分规则转写（档位描述是仲裁时的引用依据） |
| [`skill/kaoyan-essay/schema/grading-report.schema.json`](skill/kaoyan-essay/schema/grading-report.schema.json) | 机器可校验的输出契约 |
| [`skill/kaoyan-essay/prompts/`](skill/kaoyan-essay/prompts/) | 版本化提示词（阅卷员 / 仲裁员） |
| [`skill/kaoyan-essay/scripts/`](skill/kaoyan-essay/scripts/) | 确定性脚本：预检 / 报告校验 / 同档合并 / 种子评估 |
| [`app/core.js`](app/core.js) | 同一套内核的浏览器实现（ESM，Node 也能加载） |
| [`proxy/proxy-core.js`](proxy/proxy-core.js) | 共享算力代理内核（两套部署入口共用） |

改任何一处 → 跑 [种子错误评估](skill/kaoyan-essay/scripts/eval_planted.py) → 查全率/误报量化对比——内核迭代有数可依。

## 验证

### 评分质量（预注册，失败照报）

| # | 实验 | 标准 | 结果 |
|---|---|---|---|
| 1 | 同篇双评跑 3 遍 | 档位波动 0 档 | ✅ 8.5 / 8.5 / 8.5，零波动 |
| 2 | 逐句批改抽查 ≥20 处 | 把对的改错 = 0 | ✅ 35 处全量核对，0 处（[报告](docs/validation/audit-20261009.md)） |
| 3 | 字数统计 vs 人工 | 误差 ≤ 2 词 | ✅ 确定性实现，误差 0 词 |
| 4 | 分档区分度 | 好/中/差分数递减 | ✅ 14 / 8.5 / 7 |
| 5 | 句级种子查全率 | 预植错误检出 | ✅ 内核 v1.0 92% → v1.3 **100%**，误报 0（[记录](docs/validation/kernel-eval-20261009/SUMMARY.md)） |
| 6 | 跨档位覆盖 | 英一 20 分档 / 小作文 10 分档 | ✅ 分值表、档位区间、格式检测均正确（[报告](docs/validation/coverage-20261009/SUMMARY.md)） |

### 工程回归（CI 每次 push 跑，121 项断言）

| 套件 | 断言 | 守住什么 |
|---|---|---|
| `node app/test.mjs` | 55 | 字数口径、预检、JSON 容错解析、报告校验、同档合并、题型识别、反模板黑名单、汇聚尺刻度 |
| `node proxy/proxy-core.test.mjs` | 28 | CORS 放行与 expose、配额先扣后调与退额、模型白名单、max_tokens 封顶、IPv6 归并、限速表不无界增长 |
| `node app/parity.mjs` | 18 | **JS 与 Python 必须同口径**：预检事实清单逐字段一致、校验失败项数一致、合并终裁分与退出语义一致 |
| `node app/static-server.test.mjs` | 20 | 桌面壳本地端口不暴露 `.git/` 与 `data/`、路径穿越（含同前缀兄弟目录与 URL 编码）被拒、非法百分号编码不崩、Host 校验防 DNS rebinding |
| `python scripts/sync_app.py --check` | — | 副本与真源无漂移 |

> 「同口径」不是口号，是 CI 里可执行的断言。历史上 JS 与 Python 曾悄悄漂移三处（维度比较、`consistency.dimension_sum`、必填字段），导致同一份报告在网页端通过、在 Skill 端被打回——现在这类漂移会直接让 CI 变红。

## 共享算力（可选，自托管）

想给同学/学生免配置直接用？附赠一个代理，两套等价部署：

- `functions/v1/` —— **Cloudflare Pages Functions**（主路径，与网页同域 `duograder.pages.dev/v1`，国内可直连）
- `workers/invite-proxy/` —— **Cloudflare Worker**（备用路径，海外 / 自托管参考）

两者共用同一份实现 `proxy/proxy-core.js`（真源），副本由 `scripts/sync_app.py` 同步，CI 断言二者与真源逐字节一致——历史上这两套曾经漂移过一次（Worker 缺匿名通道、免费额度与配额查询，Pages 缺 IPv6 归并）。

### 两种访问方式

| 方式 | 怎么用 | 额度 |
|---|---|---|
| **邀请码** | 点右上角「登录」输入邀请码 | 不限次 |
| **匿名免费** | 什么都不填，直接用 | 每 IP + 设备指纹共 50 次（180 天） |

匿名免费额度需要额外配一个 KV 计数绑定（`FREE_KV`），没配时只有邀请码模式可用。

### 安全设计

- **API Key 只存服务端加密 secret**，前端和仓库里永远只有一个邀请码占位
- **上游地址写死**，客户端无法指定目标；**不转发客户端原始头**，逐个重建
- **模型白名单**：客户端不能借你的 key 调用任意模型
- **max_tokens 封顶**（匿名 12k / 邀请码 32k）：限制单次成本，防止免费额度被拿去跑无上限生成
- **配额先扣后调，上游失败退额**：并发请求不会同时越过配额检查
- **每 IP 限速** 120 次 / 10 分钟（实例内存滑动窗口，是第一道闸不是精确计量）；IPv6 按 /64 前缀归并
- **CORS 白名单**只放行本应用来源（`ALLOWED_ORIGINS` 可配，支持 `*.example.com` 通配，按域分量匹配）
- **不落作文数据**：代理纯转发，只有计数进 KV

### 自托管四步

```bash
python scripts/sync_app.py                                   # 生成 .pages-dist（只含 app/+skill/+跳转页）+ 同步代理副本
wrangler pages secret put MINIMAX_API_KEY
wrangler pages secret put INVITE_CODE
wrangler pages deploy
```

> **为什么输出目录是 `.pages-dist` 而不是仓库根**：仓库根里还有 `data/`（你的批改记录）、`node_modules/`、`android/`。整根发布会把它们一并暴露到公网，所以 `wrangler.toml` 的 `pages_build_output_dir` 指向 `.pages-dist`。

> **匿名免费额度**需要 KV 计数绑定。本仓的 `wrangler.toml` 里已绑好 `FREE_KV`；自建部署时改成你自己的：`wrangler kv namespace create FREE_KV` 后把返回的 id 填进 `[[kv_namespaces]]`。没绑时只有邀请码模式可用。

代码里的代理地址是演示实例；自己部署后，在 `app/core.js` 的 `PRESETS` 里改一行 `baseURL` 即可。

## 隐私

**分两种情况，说清楚：**

**① 你自带 API Key（默认）**
Key 与全部批改数据只存在**你的浏览器/手机本地**（localStorage / IndexedDB）。请求**直发你自己配置的供应商**，不经过任何 DuoGrader 服务器。仓库与线上实例都不参与。

**② 邀请码 / 匿名免费额度（走共享算力）**
请求会经过 `duograder.pages.dev` 的 Pages Function（或自建的 Worker）再转发给模型供应商——**作文内容会经过这个代理**。代理**不存储作文内容**（纯转发），但会写三类计数到 KV：每 IP 的免费次数、每设备指纹的免费次数、全站当天的匿名总次数。限速窗口是实例内存里的滑动窗口，不落盘。

设备指纹只在内置算力通道生成并发送（存 localStorage，清浏览器数据才会变）；**你自带 Key 直连第三方时不会发送**。

> 仓库与线上实例**有**后端（就是上面这个转发代理）。它只做转发与计数，不落作文、不做统计上报、不回传任何数据。

## 已知局限

如实说，不藏着：

- **"稳"已证明，"准"欠校准**——没有人工专家分对照前，绝对档位会随内核版本小幅漂移（v1.0→v1.3 同篇漂移一档，均在可辩护范围）。人工锚点校准（锚点样文 / pairwise 排序）是内核下一个研究方向。
- 全部质量验证基于合成作文；真实手写字迹的转写质量、真实考生的错误分布待真实样本补充。
- **纯前端直连供应商 API**：绝大多数主流供应商可用（实测 10 家中 8 家可直连），个别拦截的需要桌面壳或反代。
- **小作文的科目（英一/英二）无法从题面自动判定**——两者都是"约 100 词 / 10 分"，题面没有科目硬信号。网页端会明确提示你手动确认（判错科目会连分值制一起错）；SKILL.md 侧则靠真题年份匹配。
- **匿名免费额度的计数基于 KV**，KV 是最终一致的，跨 isolate 的并发理论上存在竞争窗口——已用 isolate 内串行化 + 全站每日 300 次上限双重兜底，但不是强一致计数。
- **JS 与 Python 是同一套内核的两份实现**。已用 CI 断言同口径，但改一边忘了另一边仍可能发生（CI 会红，别忽略）。
- Agent Skill 在不支持 subagent 的宿主上会退化为单上下文双评，独立性弱于标准流程。

## 致谢

评分规则的组织思路参考了 [echo-kaoyan-english-skill](https://github.com/nghjjnjnf/echo-kaoyan-english-skill)；官方档位描述转写自考研英语大纲评分标准。

## License

MIT
