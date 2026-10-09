# 覆盖面验证 · 英一 20 分档 / 小作文 10 分档 · 2026-10-09

回应"覆盖面偏科"问题：此前全部验证在英二大作文（15 分档）。本轮补两条赛道各一篇合成作文 × 单评员盲评 + 机器校验。

## 英一大作文（20 分档）

- 夹具：`prompt-synthetic-en1-large.txt`（图画作文）+ `essay-synthetic-en1-large.txt`（163 词，1 处预植性质硬伤 ourselves + 1 处搭配 pass away）
- 结果：**meta.max_score=20 正确**；维度表正确采用英一口径（6/4/3/3/3/1）；**档位区间正确用英一表 [17,20]**；定第五档 17 分，维度和=17 自洽
- 亮点：ourselves 指代硬伤（动名词主语≠we，应作 us）判定准确；pass away（多表"去世"）用于时间流逝的歧义搭配被标 awkward——两条都是高质量真发现
- validate_report.py：通过

## 英一小作文（10 分档）

- 夹具：`prompt-synthetic-small.txt`（邀请邮件）+ `essay-synthetic-small.txt`（101 词）
- 结果：**meta.max_score=10 正确**；维度表正确采用小作文口径（3/2/2/2/1）；**档位区间正确用 [9,10]**；定第五档 10 分
- precheck 格式检测：salutation/closing/signature_li_ming 三项全部正确检出
- 唯一批改为 style 级（I am looking forward → I look forward），级别恰当
- validate_report.py：通过

## 结论与残留

英一 20 分档与小作文 10 分档的分值表、维度表、档位区间、格式检测**均按 rubric 正确执行**（各 1 篇，单评员）。残留：每档样本量仍为 1，多档位分布（如英一第三档作文）与真人对照仍待校准机制。
