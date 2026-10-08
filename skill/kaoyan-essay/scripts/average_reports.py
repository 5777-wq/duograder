#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""同档双评的确定性合并（rubric v1.2：同档均值是算术，交给脚本；档位之争才交给仲裁员）。

两份报告同档 -> 逐维取均值（0.25 粒度展示）-> 总分收敛到 0.5 粒度（尾数从严向下）
-> 校验总分落在档位区间 -> 输出终裁报告。
档位不一致 -> exit 2（需要仲裁员 subagent）。

用法: python average_reports.py graderA.json graderB.json [out.json]
"""
import json
import math
import re
import sys

BAND_TABLE = {
    10: {5: (9, 10), 4: (7, 8), 3: (5, 6), 2: (3, 4), 1: (1, 2), 0: (0, 0)},
    20: {5: (17, 20), 4: (13, 16), 3: (9, 12), 2: (5, 8), 1: (1, 4), 0: (0, 0)},
    15: {5: (13, 15), 4: (10, 12), 3: (7, 9), 2: (4, 6), 1: (1, 3), 0: (0, 0)},
}


def load_json(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read().strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
        raw = re.sub(r"\n?```\s*$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        repaired = re.sub(r"\}\s*\{\s*\"", '},{"', raw)
        if repaired != raw:
            print("[已修复] JSON 数组对象间缺失逗号，已自动补上")
        return json.loads(repaired)


def snap_half_down(x):
    """收敛到 0.5 粒度；恰在 .25/.75 中点时从严向下。"""
    return math.floor(x * 2 + 0.499999) / 2


def main():
    a_path, b_path = sys.argv[1], sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else None
    a, b = load_json(a_path), load_json(b_path)

    band_a, score_a = a["band"]["band"], a["scores"]["total"]
    band_b, score_b = b["band"]["band"], b["scores"]["total"]

    if band_a != band_b:
        print(f"档位不一致（A 第{band_a}档 {score_a} 分 vs B 第{band_b}档 {score_b} 分），需要仲裁员")
        sys.exit(2)

    dims_a = {d["name"]: d for d in a["scores"]["dimensions"]}
    dims_b = {d["name"]: d for d in b["scores"]["dimensions"]}
    if set(dims_a) != set(dims_b):
        print(f"维度命名不一致：{set(dims_a) ^ set(dims_b)}，打回重评")
        sys.exit(3)

    merged_dims, dim_sum = [], 0.0
    for name in dims_a:
        sa, sb = dims_a[name]["score"], dims_b[name]["score"]
        mean = (sa + sb) / 2
        dim_sum += mean
        merged_dims.append({
            "name": name, "max": dims_a[name]["max"], "score": mean,
            "note": f"A给{sa}，B给{sb}，均值{mean:g}",
        })

    total = snap_half_down(dim_sum)
    max_score = a["meta"]["max_score"]
    lo, hi = BAND_TABLE[max_score][band_a]
    if not (lo <= total <= hi):
        print(f"合并后总分 {total} 落在档位区间 [{lo}, {hi}] 之外，需要仲裁员复核")
        sys.exit(2)

    final = {
        "needs_regrade": False, "decision": "same_band",
        "final_band": band_a, "final_score": total, "final_range": [lo, hi],
        "dimensions": merged_dims,
        "rationale": f"两位阅卷员同档（band_gap=0），按 rubric 第7节逐维取均值、总分收敛至0.5粒度（尾数从严），由脚本确定性合并。",
        "initial": [{"grader": "A", "band": band_a, "score": score_a},
                    {"grader": "B", "band": band_b, "score": score_b}],
        "band_gap": 0, "score_gap": round(abs(score_a - score_b), 2),
    }
    text = json.dumps(final, ensure_ascii=False, indent=2)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"已写出: {out_path}")
    print(f"终裁: 第{band_a}档 {total} 分 / {max_score}（维度均值和 {dim_sum:g}）")
    print(f"初评: A {score_a} / B {score_b}，分差 {final['score_gap']}")


if __name__ == "__main__":
    sys.exit(main())
