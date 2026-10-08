#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DuoGrader 确定性预检：字数 / 段落 / 格式 / 机械性问题。

输出 JSON 事实清单，注入评分提示词。评分者只准引用这里的数字，禁止自算。

用法:
  python precheck.py --track english-ii --task large essay.txt
  python precheck.py --track english-i --task small --prompt-file prompt.txt essay.txt

仅依赖标准库。
"""
import argparse
import json
import re
import sys

# (track, task) -> (建议下限, 建议上限)；小作文"约100词"上下限同值
RECOMMENDED = {
    ("english-i", "small"): (100, 100),
    ("english-i", "large"): (160, 200),
    ("english-ii", "small"): (100, 100),
    ("english-ii", "large"): (150, 150),
}

# 词的口径：字母词（含 don't / well-known 这类一体词）或数字串（含 84.8% 这类一体词）
WORD_RE = re.compile(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*|\d+(?:[.,]\d+)*%?")
CHINESE_RE = re.compile(r"[\u4e00-\u9fff]")
SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def count_words(text: str) -> int:
    return len(WORD_RE.findall(text))


def split_paragraphs(text: str):
    """优先按空行分段；无空行时退化为按行分段（拍照转写常见），并标注分段依据。"""
    blocks = [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    basis = "blank_line"
    if len(blocks) == 1 and "\n" in blocks[0]:
        blocks = [l.strip() for l in blocks[0].splitlines() if l.strip()]
        basis = "single_newline"
    return blocks, basis


def length_status(count: int, lo: int, hi: int):
    """对应 writing-rubric.md 第 4 节扣分锚点 3。"""
    ratio = count / lo if lo else 1.0
    if ratio >= 0.8:
        status = "ok" if ratio >= 1.0 else "soft_ok"
    elif ratio >= 2 / 3:
        status = "soft_short"          # 67%-80%：不机械罚分，批改中提示
    elif ratio >= 0.5:
        status = "short_two_thirds"    # <67%：任务完成维度减半且封顶第三档
    else:
        status = "short_half"          # <50%：封顶第二档
    overlong = count > hi * 1.5 if hi and hi != lo else False
    return ratio, status, overlong


def mechanical_flags(text: str, sentences):
    flags = []
    n_zh = len(CHINESE_RE.findall(text))
    if n_zh:
        flags.append({"type": "chinese_chars", "count": n_zh,
                      "detail": "作文正文含中文字符（疑似混入）"})
    repeated = re.findall(r"\b([A-Za-z]+)\s+\1\b", text, flags=re.IGNORECASE)
    if repeated:
        uniq = sorted({w.lower() for w in repeated})
        flags.append({"type": "repeated_word", "count": len(repeated),
                      "detail": "疑似相邻重复词: " + ", ".join(uniq[:8])})
    missing_space = re.findall(r"[A-Za-z][,.;:!?][A-Za-z]", text)
    if missing_space:
        flags.append({"type": "missing_space_after_punct", "count": len(missing_space),
                      "detail": "标点后疑似缺空格（如 word,Next）"})
    no_ellipsis = text.replace("...", "")
    double_punct = re.findall(r"[,;:!?]{2,}", no_ellipsis)
    if double_punct:
        flags.append({"type": "double_punct", "count": len(double_punct),
                      "detail": "连续标点（省略号除外）"})
    lower_starts = [s.strip()[:30] for s in sentences if s.strip() and s.strip()[0].islower()]
    if lower_starts:
        flags.append({"type": "lowercase_sentence_start", "count": len(lower_starts),
                      "detail": "句首小写: " + " | ".join(lower_starts[:3])})
    return flags


def small_writing_format(text: str):
    return {
        "salutation": bool(re.search(r"(?im)^\s*dear\s+", text)),
        "closing": bool(re.search(r"(?im)yours\s+(sincerely|faithfully|truly)", text))
                    or bool(re.search(r"(?im)^\s*best\s+wishes", text)),
        "signature_li_ming": bool(re.search(r"(?im)^\s*li\s+ming\s*\.?\s*$", text)),
    }


def main():
    ap = argparse.ArgumentParser(description="DuoGrader 确定性预检")
    ap.add_argument("essay", help="作文文本文件（UTF-8）")
    ap.add_argument("--track", required=True, choices=["english-i", "english-ii"])
    ap.add_argument("--task", required=True, choices=["small", "large"])
    ap.add_argument("--prompt-file", default=None, help="题面文件（仅记录，供评分者对照）")
    args = ap.parse_args()

    with open(args.essay, encoding="utf-8") as f:
        text = f.read()

    words = count_words(text)
    paras, basis = split_paragraphs(text)
    sentences = [s for s in SENT_SPLIT_RE.split(text.strip()) if s.strip()]
    lo, hi = RECOMMENDED[(args.track, args.task)]
    ratio, status, overlong = length_status(words, lo, hi)

    result = {
        "track": args.track,
        "task": args.task,
        "prompt_file": args.prompt_file,
        "word_count": words,
        "recommended_words": [lo, hi],
        "ratio_to_minimum": round(ratio, 3),
        "length_status": status,
        "overlong": overlong,
        "paragraph_count": len(paras),
        "paragraph_basis": basis,
        "paragraph_word_counts": [count_words(p) for p in paras],
        "sentence_count": len(sentences),
        "avg_sentence_words": round(words / len(sentences), 1) if sentences else 0,
        "mechanical_flags": mechanical_flags(text, sentences),
    }
    if args.task == "small":
        result["small_writing_format"] = small_writing_format(text)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
