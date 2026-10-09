#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单一真源同步：duograder/app → 三份副本（止住手工拷贝分叉）。

唯一真源：duograder/app/（index.html ui.js core.js style.css logo.svg icon*.png manifest.json）
副本：
  1. duograder/.pages-dist/        —— Cloudflare Pages 部署目录（app/ 子目录 + 根跳转 + skill/）
  2. duograder-app/www/            —— Capacitor webDir（根路径布局 + skill/）
  3. duograder-app/android/.../assets/public/ —— APK 内置资产（保留 capacitor 运行时文件）

用法：python scripts/sync_app.py   （在 duograder 仓库根目录执行）
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
FILES = ["index.html", "ui.js", "core.js", "style.css", "logo.svg", "icon.png", "icon-192.png", "manifest.json"]
# capacitor 运行时文件：同步 assets 时必须保留，不能当作过期副本删掉
CAP_RUNTIME = {"cordova.js", "cordova_plugins.js", "capacitor.config.json", "capacitor.plugins.json"}


def copy_app_files(dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    for f in FILES:
        shutil.copy2(APP / f, dest / f)


def sync_skill(dest_root: Path):
    skill = dest_root / "skill"
    if skill.exists():
        shutil.rmtree(skill)
    shutil.copytree(ROOT / "skill", skill)


def sync_pages_dist():
    d = ROOT / ".pages-dist"
    d.mkdir(exist_ok=True)
    app_dir = d / "app"
    app_dir.mkdir(exist_ok=True)
    copy_app_files(app_dir)
    sync_skill(d)
    redirect = d / "index.html"
    redirect.write_text(
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
        '<meta http-equiv="refresh" content="0;url=/app/"><title>DuoGrader</title></head>'
        '<body style="background:#f0f2f5;font-family:sans-serif;display:flex;align-items:center;'
        'justify-content:center;height:100vh;margin:0"><a href="/app/" style="color:#c4633f">进入 DuoGrader →</a></body></html>',
        encoding="utf-8",
    )
    print(f"✓ .pages-dist 已同步（{len(FILES)} 文件 + skill + 跳转页）")


def sync_www(dest: Path, label: str):
    if dest.exists():
        for child in dest.iterdir():
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    copy_app_files(dest)          # 根路径布局：页面文件在 www 根
    sync_skill(dest)
    print(f"✓ {label} 已同步（根路径布局）")


def sync_apk_assets():
    assets = ROOT.parent / "duograder-app" / "android" / "app" / "src" / "main" / "assets" / "public"
    if not assets.exists():
        print("! 未找到 APK assets 目录，跳过（duograder-app 未克隆？）")
        return
    for child in assets.iterdir():
        if child.name in CAP_RUNTIME:
            continue
        shutil.rmtree(child) if child.is_dir() else child.unlink()
    copy_app_files(assets)
    sync_skill(assets)
    print("✓ APK assets 已同步（保留 capacitor 运行时文件）")


def main():
    if not APP.exists():
        sys.exit("找不到 app/ 真源目录")
    sync_pages_dist()
    apk_root = ROOT.parent / "duograder-app"
    sync_www(apk_root / "www", "duograder-app/www")
    sync_apk_assets()
    print("全部副本已与 app/ 对齐。记得提交 duograder-app 并触发 APK 构建。")


if __name__ == "__main__":
    main()
