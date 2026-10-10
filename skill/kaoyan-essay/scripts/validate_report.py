#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DuoGrader 单评报告校验：不达标即打回重评。

硬性失败（exit 1）：缺字段 / 元数据组合非法 / 档位区间错 / 维度分之和 != 总分 /
维度分之和不在档位区间 / severity 非法 / 润色级用了"错误"措辞 /
可复用 patterns 含模板套话（rubric 5.2 黑名单）/ top_problems 数量。
警告（不计失败）：逐句批改的 original 与作文原文对不上（引文风格差异可能误报）。

用法:
  python validate_report.py report.json essay.txt
"""
import json
import re
import sys

BAND_TABLE = {
    10: {5: (9, 10), 4: (7, 8), 3: (5, 6), 2: (3, 4), 1: (1, 2), 0: (0, 0)},
    20: {5: (17, 20), 4: (13, 16), 3: (9, 12), 2: (5, 8), 1: (1, 4), 0: (0, 0)},
    15: {5: (13, 15), 4: (10, 12), 3: (7, 9), 2: (4, 6), 1: (1, 3), 0: (0, 0)},
}
VALID_META = {
    ("english-i", "small", 10), ("english-ii", "small", 10),
    ("english-i", "large", 20), ("english-ii", "large", 15),
}
# v1.4 起级别用中文；error/awkward/style 为历史报告兼容
SEVERITIES = {"错误", "欠佳", "润色"}
SEVERITY_ALIAS = {"error": "错误", "awkward": "欠佳", "style": "润色"}
# rubric 5.2 黑名单：reusable.patterns 出现即打回
REUSABLE_BLACKLIST = [
    "warm and happy", "every coin has two sides", "with the development of",
    "i will be very happy", "as far as i am concerned",
]
EPS = 0.01


def norm_sev(v):
    return SEVERITY_ALIAS.get(v, v)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    raw = raw.strip()
    if raw.startswith("```"):  # 容错：剥掉模型可能加的 markdown 围栏
        raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
        raw = re.sub(r"\n?```\s*$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # 容错：修复数组对象间漏逗号（}{"name"... -> },{"name"...），LLM 高频笔误
        repaired = re.sub(r"\}\s*\{\s*\"", '},{"', raw)
        if repaired != raw:
            print("[已修复] JSON 数组对象间缺失逗号，已自动补上")
        return json.loads(repaired)


def norm(s):
    return " ".join(s.split())


def main():
    report_path, essay_path = sys.argv[1], sys.argv[2]
    report = load_json(report_path)
    with open(essay_path, encoding="utf-8") as f:
        essay = norm(f.read())

    failures, warnings = [], []

    for field in ["meta", "band", "scores", "consistency",
                  "sentence_edits", "improved_version", "top_problems"]:
        if field not in report:
            failures.append(f"缺少必填字段: {field}")

    meta = report.get("meta", {})
    key = (meta.get("exam_track"), meta.get("task"), meta.get("max_score"))
    if key not in VALID_META:
        failures.append(f"meta 组合非法: {key}（如英二大作文必须 15 分制）")
    if not isinstance(meta.get("word_count_reported"), int) or meta.get("word_count_reported", 0) <= 0:
        failures.append("meta.word_count_reported 必须是正整数（引用预检值）")

    band = report.get("band", {})
    b, rng = band.get("band"), band.get("range")
    if not isinstance(b, int) or b not in BAND_TABLE.get(meta.get("max_score", 0), {}):
        failures.append(f"档位非法: {b}")
    else:
        expect = list(BAND_TABLE[meta["max_score"]][b])
        if rng != expect:
            failures.append(f"档位区间错: 报告 {rng}，应为 {expect}")
    if len(str(band.get("rationale", ""))) < 20:
        failures.append("band.rationale 太短，须引用档位描述关键词")

    scores = report.get("scores", {})
    dims = scores.get("dimensions", [])
    total = scores.get("total")
    if not dims:
        failures.append("维度分为空")
    dim_sum = 0.0
    for d in dims:
        if not (0 <= d.get("score", -1) <= d.get("max", -1) + EPS):
            failures.append(f"维度 {d.get('name')} 分值越界: {d.get('score')}/{d.get('max')}")
        if len(norm(d.get("evidence", ""))) < 5:
            failures.append(f"维度 {d.get('name')} 缺少原文证据")
        dim_sum += d.get("score", 0)
    if total is None or abs(dim_sum - total) > EPS:
        failures.append(f"维度分之和 {dim_sum} != 总分 {total}")
    if isinstance(b, int) and b in BAND_TABLE.get(meta.get("max_score", 0), {}):
        lo, hi = BAND_TABLE[meta["max_score"]][b]
        if not (lo - EPS <= dim_sum <= hi + EPS):
            failures.append(f"维度分之和 {dim_sum} 不在档位区间 [{lo}, {hi}] 内")

    cons = report.get("consistency", {})
    if cons.get("in_band_range") is not True:
        failures.append("consistency.in_band_range 必须为 true（不达标应先自行调整再输出）")
    if abs(cons.get("dimension_sum", -1) - dim_sum) > EPS:
        failures.append("consistency.dimension_sum 与维度分之和不符")

    for i, e in enumerate(report.get("sentence_edits", [])):
        sev = norm_sev(e.get("severity"))
        if sev not in SEVERITIES:
            failures.append(f"逐句批改[{i}] severity 非法: {e.get('severity')}")
        if sev == "润色" and re.search(r"错误", re.sub(r"(并无|不是|没有|不算|不属于|不含|非)错误", "", e.get("issue", ""))):
            failures.append(f"逐句批改[{i}] 润色级不得使用'错误'措辞（否定式表述除外）")
        if norm(e.get("original", "")) and norm(e["original"]) not in essay:
            warnings.append(f"逐句批改[{i}] original 与原文不符: {e['original'][:40]}...")

    for i, p in enumerate(report.get("reusable", {}).get("patterns", [])):
        low = str(p).lower()
        hit = next((b for b in REUSABLE_BLACKLIST if b in low), None)
        if hit:
            failures.append(f"可复用 patterns[{i}] 含模板套话 '{hit}'，须换成本题骨架（rubric 5.2）")
        elif "..." not in low and "___" not in low:
            warnings.append(f"可复用 patterns[{i}] 缺少 .../___ 填空位（建议改为骨架形式）: {str(p)[:40]}")

    n_problems = len(report.get("top_problems", []))
    if not (2 <= n_problems <= 3):
        failures.append(f"top_problems 应为 2-3 条，实际 {n_problems} 条")

    for w in warnings:
        print(f"[警告] {w}")
    if failures:
        for f_ in failures:
            print(f"[失败] {f_}")
        print(f"校验未通过：{len(failures)} 项硬性违规，{len(warnings)} 项警告 —— 打回重评")
        sys.exit(1)
    print(f"校验通过：0 项违规，{len(warnings)} 项警告")


if __name__ == "__main__":
    sys.exit(main())
