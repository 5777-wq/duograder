# dsh-duograder

**考研英语作文双评批改（[DuoGrader](https://github.com/5777-wq/duograder)）以 DeepSeek Harness 插件形态分发。**

装好之后，在 DSH 里直接说"批改这篇考研英语作文"，agent 会自动加载 `kaoyan-essay` skill：确定性预检 → 两位阅卷员独立盲评 → 机器校验 → 同档脚本合并 / 差档仲裁 → 逐句精改报告。

## 为什么它天然适合 DSH

DuoGrader 的核心是**双盲**：两位阅卷员必须互不可见，否则双评就退化成一次评分。

DSH 原生的 `subagent`（`spawn` provider）本来就满足这条——它的子 agent 有独立上下文，工具描述里明确写着 *"it does not see this conversation"*。所以这个插件不需要自己发 LLM 请求，也不需要造一套隔离机制，**隔离由宿主提供**。

> 这一点是可验证的：在其它不支持 subagent 的宿主上，DuoGrader 只能退化成"单上下文双评"，报告里必须标注独立性变弱。在 DSH 上不触发这个降级。

## 安装

> ⚠️ **先读：`desktop` profile 由 Electron 应用独占管理，CLI 不允许往里装插件。**
> 直接跑 `dsh plugin --profile desktop add ...` 会报
> `profile "desktop" is managed exclusively by the Electron application`。

**A. 桌面版（Electron）** —— 在 DSH 应用内的「设置 → 插件」里添加本包（npm 名或本地目录），装完重开应用。

**B. `dsh web` 或其它 profile** —— 需要 `pnpm`：

```sh
dsh plugin --profile web add dsh-duograder
```

**C. 本地开发指着目录装**：

```sh
git clone https://github.com/5777-wq/duograder.git
cd duograder
python scripts/sync_app.py        # 生成 dsh-plugin/assets/（已 gitignore，不随仓库分发）
dsh plugin --profile web add ./dsh-plugin
```

### 安装时会碰到的两个坑（实测）

**① 包路径不能含空格。** DSH CLI 把 `add <路径>` 的参数按空格拆分，
`D:\57的vibe coding内容\duograder\dsh-plugin` 会被拆成两个包名（`57的vibe` 和 `dsh-plugin`）。
从本地目录安装时，先把包拷到不含空格的路径（如 `C:\tmp\duograder-plugin`）再 `add`。

**② profile 需要 `.npmrc`。** profile 自带的 `pnpm-workspace.yaml` 有 `packages: - .`，pnpm 9 会判定
为 workspace root 而拒绝安装（`ERR_PNPM_ADDING_TO_ROOT`）。在 profile 目录下建 `.npmrc`：

```ini
ignore-workspace-root-check=true
```

以上两点是 DSH CLI / pnpm 的行为，不是本插件的问题，但不写下来会让人以为插件坏了。

## 用法

装好后无需任何配置。三种触发方式：

- 直接描述任务：「批改这篇考研英语作文，英语二大作文」+ 粘贴或拍照
- 显式调用：输入 `/kaoyan-essay`
- 让 agent 自己判断：只要任务明确是考研英语（英一/英二）写作，它会加载 skill

然后按 skill 的流程走：确认科目题型 → 核对转写 → 预检 → 双盲评分 → 出报告。

## 它做了什么、没做什么

| | 说明 |
|---|---|
| ✅ 注册 skill | 把 `kaoyan-essay` 注册为内置 skill 提供方（`ctx.skills.registerProvider`） |
| ✅ 随包分发 | 评分规则、输出契约、提示词、确定性脚本都在 `assets/kaoyan-essay/`，装完即用，不依赖仓库克隆 |
| ✅ 零模型成本 | 插件本身不调用任何模型；成本只发生在你真正批改时（一次批改 = 双评 + 可能的仲裁） |
| ❌ 不重写评分逻辑 | 评分逻辑只有一份真源：仓库根的 `skill/kaoyan-essay/`。`assets/` 是 `sync_app.py` 生成的构建副本 |
| ❌ 不带 Web UI | 报告以 Markdown 由 agent 输出。网页端的双评汇聚尺、成绩曲线、分享卡片仍在 [duograder.pages.dev](https://duograder.pages.dev/app/) |

## 依赖

- DeepSeek Harness `0.2.0-rc.1` 及以上（已在 `0.2.1-rc.2` 实测）
- `@deepseek-ai/dsh-skill`（skill 注册表）——DSH 默认组合已包含
- **Python 3** ——确定性预检与报告校验脚本需要。没装 Python 时评分仍能跑，但字数/段落只能靠模型自己数（这会突破 skill 的"字数只准引用不准自算"铁律，强烈建议装上）

## 数据与隐私

- 插件本身**不收集、不外发**任何数据
- 作文内容走你自己的 DSH 模型配置，不经过 DuoGrader 的服务器
- 批改记录由 skill 写入 `data/`（该目录被 git 忽略）

## 已知限制

- **小作文的科目（英一/英二）无法从题面自动判定**——两者都是"约 100 词 / 10 分"。skill 会请你确认，别跳过。
- **需要宿主支持 subagent**。如果你的 DSH 组合禁用了 `dsh-subagent`，双评会退化为单上下文两轮自评，报告会明确标注。
- **Python 脚本路径依赖 cwd**。在 duograder 仓库内使用时相对路径可直接解析；在其它项目里使用时，skill 会按资源基目录解析（DSH 加载 skill 时会给出 `Base directory for this skill:`）。

## License

MIT —— 与 [DuoGrader](https://github.com/5777-wq/duograder) 一致。
