#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内核评估：种子错误查全率 / 误报清单。

对一份"故意埋了已知错误"的作文跑批改后，把阅卷员的 sentence_edits
与种子清单（planted-errors.json）比对，输出：
  - 每颗种子：是否被检出（按 severity 匹配）
  - 误报候选：severity=error 但不匹配任何种子的条目（需人工复核——
    考生原文里可能真有我们没预植的错，这类不算模型错，但必须逐条披露）

用法:
  python eval_planted.py report.json --essay essay.txt \
      --fixture ../tests/fixtures/planted-errors.json
"""
import argparse
import json
import re
import sys


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


# v1.4 起报告级别用中文；种子清单沿用英文，比对前归一
SEV_ALIAS = {"错误": "error", "欠佳": "awkward", "润色": "style"}


def sev(e) -> str:
    return SEV_ALIAS.get(e.get("severity"), e.get("severity"))


def load_report(path):
    raw = open(path, encoding="utf-8").read().strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
        raw = re.sub(r"\n?```\s*$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return json.loads(re.sub(r"\}\s*\{\s*\"", '},{"', raw))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("report")
    ap.add_argument("--essay", required=True)
    ap.add_argument("--fixture", default="../tests/fixtures/planted-errors.json")
    args = ap.parse_args()

    report = load_report(args.report)
    seeds = json.load(open(args.fixture, encoding="utf-8"))
    edits = report.get("sentence_edits", [])

    detected, missed = [], []
    used = set()
    for seed in seeds:
        pat = norm(seed["pattern"])
        hit = None
        for i, e in enumerate(edits):
            if norm(e.get("original", "")).find(pat) >= 0:
                if seed["expected"] in ("any", sev(e)):
                    hit = i
                else:
                    hit = ("wrong-severity", i, sev(e))
                break
        if hit is None:
            missed.append(seed)
        else:
            if isinstance(hit, int):
                used.add(hit)
                detected.append({**seed, "result": "ok"})
            else:
                detected.append({**seed, "result": hit[0]})

    fp_candidates = []
    for i, e in enumerate(edits):
        if i in used or sev(e) != "error":
            continue
        if not any(norm(s["pattern"]) in norm(e.get("original", "")) for s in seeds):
            fp_candidates.append(e.get("original", "")[:60])

    n = len(seeds)
    recall = len(detected) / n if n else 0
    print(f"种子错误 {n} 个：检出 {len(detected)}，漏报 {len(missed)} → 查全率 {recall:.0%}")
    for m in missed:
        print(f"  [漏报] {m['id']}（{m['pattern']}，期望 {m['expected']}）")
    wrong = [d for d in detected if d["result"] != "ok"]
    for w in wrong:
        print(f"  [级别不符] {w['id']}：期望 {w['expected']}")
    print(f"severity=error(错误) 的条目共 {sum(1 for e in edits if sev(e) == 'error')} 条；"
          f"其中 {len(fp_candidates)} 条不匹配任何种子 → 误报候选（人工复核）")
    for f_ in fp_candidates:
        print(f"  [误报候选] {f_}...")

    json.dump({
        "seeds": n, "detected": len(detected), "missed": [m["id"] for m in missed],
        "wrong_severity": [w["id"] for w in wrong],
        "fp_candidates": fp_candidates, "recall": round(recall, 2),
    }, open(args.report + ".eval.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"评估明细已写入 {args.report}.eval.json")
    sys.exit(0 if not missed else 1)


if __name__ == "__main__":
    sys.exit(main())
