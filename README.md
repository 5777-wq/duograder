<div align="center">

<img src="docs/assets/logo.svg" width="76" alt="DuoGrader">

# DuoGrader · 双评阅卷官

**像真实考研阅卷一样批改你的英语作文**

两位 AI 阅卷员独立盲评 · 分差仲裁 · 逐句精改 · 确定性预检
自带 API Key，免会员，数据不出本地

[![CI](https://github.com/5777-wq/duograder/actions/workflows/ci.yml/badge.svg)](https://github.com/5777-wq/duograder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fduograder.pages.dev%2Fapp%2F&label=%E5%AE%98%E7%BD%91)](https://duograder.pages.dev/app/)

**🌐 [在线使用 · 无需安装](https://duograder.pages.dev/app/)**　|　📱 [安卓 App](#-三种用法)　|　🤖 [Agent Skill](#-三种用法)

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
| 报告自相矛盾无人发现 | **机器校验**：维度分之和必须落在档位区间，不达标自动打回重评 |

效果有数：同一篇作文 3 轮双评**档位零波动**；12 颗预植错误的句级查全率 **100%**、误报 **0**；35 处逐句批改人工审计**把对的改错 = 0**。全部实验记录公开在 [`docs/validation/`](docs/validation/)，失败照报。

## 三种用法

**🌐 网页 / 手机（推荐，零安装）**
打开 [duograder.pages.dev/app](https://duograder.pages.dev/app/) → 设置里选供应商、填 API Key →「一键诊断」四项全绿 → 拍照或拖入作文 → 核对 AI 转写 → 双评。手机浏览器打开后"添加到主屏幕"即是全屏 App。

**📦 安卓 App**
下载 [Releases](https://github.com/5777-wq/duograder-app/releases) 中的 APK 安装（或自建私有仓用 Actions 构建，见 [app 说明](https://github.com/5777-wq/duograder-app)）。原生壳无跨域限制，任意供应商可直连。

**🤖 Agent Skill**
适用于 Codex / Claude Code / ZCode 等支持 skill 的 agent：

```bash
git clone https://github.com/5777-wq/duograder.git
```

把仓库交给你的 agent，说："读取 `skill/kaoyan-essay/SKILL.md` 并按其执行：批改这篇考研英语作文"。宿主将自动完成预检、双盲评分、机器校验与仲裁。

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

核心资产是 [`skill/kaoyan-essay/`](skill/kaoyan-essay/) 下的**内核三件套**：官方五档评分规则转写（[writing-rubric.md](skill/kaoyan-essay/rubrics/writing-rubric.md)）、机器可校验的输出契约（[schema](skill/kaoyan-essay/schema/grading-report.schema.json)）、版本化提示词（[prompts/](skill/kaoyan-essay/prompts/)）。改任何一处 → 跑 [种子错误评估](skill/kaoyan-essay/scripts/eval_planted.py) → 查全率/误报量化对比——内核迭代有数可依。

## 验证（预注册，失败照报）

| # | 实验 | 标准 | 结果 |
|---|---|---|---|
| 1 | 同篇双评跑 3 遍 | 档位波动 0 档 | ✅ 8.5 / 8.5 / 8.5，零波动 |
| 2 | 逐句批改抽查 ≥20 处 | 把对的改错 = 0 | ✅ 35 处全量核对，0 处（[报告](docs/validation/audit-20261009.md)） |
| 3 | 字数统计 vs 人工 | 误差 ≤ 2 词 | ✅ 确定性实现，误差 0 词 |
| 4 | 分档区分度 | 好/中/差分数递减 | ✅ 14 / 8.5 / 7 |
| 5 | 句级种子查全率 | 预植错误检出 | ✅ 内核 v1.0 92% → v1.3 **100%**，误报 0（[记录](docs/validation/kernel-eval-20261009/SUMMARY.md)） |
| 6 | 跨档位覆盖 | 英一 20 分档 / 小作文 10 分档 | ✅ 分值表、档位区间、格式检测均正确（[报告](docs/validation/coverage-20261009/SUMMARY.md)） |

## 已知局限

如实说，不藏着：

- **"稳"已证明，"准"欠校准**——没有人工专家分对照前，绝对档位会随内核版本小幅漂移（v1.0→v1.3 同篇漂移一档，均在可辩护范围）。人工锚点校准（锚点样文 / pairwise 排序）是内核下一个研究方向。
- 全部验证基于合成作文；真实手写字迹的转写质量、真实考生的错误分布待真实样本补充。
- 纯前端直连供应商 API：绝大多数主流供应商可用（实测 10 家中 8 家可直连），个别拦截的需要桌面壳或反代。

## 隐私

API Key 与全部批改数据只存在**你的浏览器/手机本地**；请求直发你自己配置的供应商；本仓库与线上实例均无后端、无统计、无上传。仓库不含任何真题原文与教辅范文。

## 共享算力（可选，自托管）

想给同学/学生免配置直接用？附赠一个 Cloudflare 代理（[workers/invite-proxy](workers/invite-proxy) + [functions/v1](functions/v1) 两套等价实现）：

- **API Key 只存 Cloudflare 加密 secret**，前端和仓库里永远只有一个邀请码占位；访客点「登录」输邀请码即可用你预设的模型
- 无存储纯转发：代理不落任何作文数据；上游地址写死、只开放批改所需两个路径、CORS 白名单、每 IP 限速
- 自托管三步：`wrangler deploy` → `wrangler secret put MINIMAX_API_KEY` → `wrangler secret put INVITE_CODE`（Pages Functions 版把函数放 `functions/` 后正常 `pages deploy` 即可，国内可直连同域地址）
- 代码里的代理地址是演示实例；自己部署后，在 `app/core.js` 的 PRESETS 里改一行 baseURL 即可


## 致谢

评分规则的组织思路参考了 [echo-kaoyan-english-skill](https://github.com/nghjjnjnf/echo-kaoyan-english-skill)；官方档位描述转写自考研英语大纲评分标准。

## License

MIT
