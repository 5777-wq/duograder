#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单一真源同步：duograder/app → 三份副本；duograder/proxy → 两份副本（止住手工拷贝分叉）。

唯一真源：
  duograder/app/    index.html ui.js core.js style.css logo.svg icon*.png manifest.json
  duograder/proxy/  proxy-core.js（两套代理入口共用的实现）

副本：
  1. duograder/.pages-dist/                —— Cloudflare Pages 部署目录（app/ 子目录 + 根跳转 + skill/）
  2. www/                                —— Capacitor webDir（根路径布局 + skill/）
  3. android/.../assets/public/          —— APK 内置资产（保留 capacitor 运行时文件）
  4. functions/v1/_proxy-core.js          —— Pages Functions 入口引用的实现副本
  5. workers/invite-proxy/_proxy-core.js  —— Workers 入口引用的实现副本

副本 4/5 必须与真源逐字节一致：两套代理历史上已经漂移过一次（Worker 缺匿名通道、
免费额度与配额查询，Pages 缺 IPv6 归并），CI 用 `--check` 断言不漂移。

用法：
  python scripts/sync_app.py           # 同步（本地开发 / 打包前）
  python scripts/sync_app.py --check   # 只校验有无漂移，有漂移则 exit 1（CI 用）
"""
import filecmp
import shutil
import sys
from pathlib import Path

# Windows 控制台默认 GBK，打印 ✓ / 中文会抛 UnicodeEncodeError；统一转 UTF-8 且不因个别字符失败
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
PROXY = ROOT / "proxy"

APP_FILES = ["index.html", "ui.js", "core.js", "style.css", "sw.js", "logo.svg", "icon.png", "icon-192.png", "manifest.json"]
# capacitor 运行时文件：同步 assets 时必须保留，不能当作过期副本删掉
CAP_RUNTIME = {"cordova.js", "cordova_plugins.js", "capacitor.config.json", "capacitor.plugins.json"}

# 代理内核真源 → 副本清单
PROXY_COPIES = [
    (PROXY / "proxy-core.js", ROOT / "functions" / "v1" / "_proxy-core.js"),
    (PROXY / "proxy-core.js", ROOT / "workers" / "invite-proxy" / "_proxy-core.js"),
]

# 桌面壳（Electron）打包需要 skill/ 进包：electron-builder 的 files 不能跨出 app/，
# 所以在 app/ 下放一份构建期副本（真源仍是仓库根的 skill/）。
DESKTOP_SKILL = ROOT / "app" / "skill"

CHECK_ONLY = "--check" in sys.argv


def _copy(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def _same(src: Path, dst: Path) -> bool:
    return dst.exists() and filecmp.cmp(src, dst, shallow=False)


def check_proxy_copies() -> list:
    """返回漂移清单（空列表 = 一致）。"""
    drift = []
    for src, dst in PROXY_COPIES:
        if not src.exists():
            drift.append(f"真源缺失: {src.relative_to(ROOT)}")
        elif not _same(src, dst):
            drift.append(f"副本与真源不一致: {dst.relative_to(ROOT)}")
    return drift


def check_desktop_skill() -> list:
    """app/skill/ 与真源 skill/ 的漂移清单。"""
    src = ROOT / "skill"
    if not src.exists():
        return ["真源缺失: skill/"]
    if not DESKTOP_SKILL.exists():
        return ["app/skill/ 缺失（桌面壳打包需要）"]
    drift = []

    def walk(c):
        if c.left_only:
            drift.append(f"app/skill/ 缺少: {c.left_only}")
        if c.right_only:
            drift.append(f"app/skill/ 多余: {c.right_only}")
        if c.diff_files:
            drift.append(f"app/skill/ 内容不一致: {c.diff_files}")
        for sub in c.subdirs.values():
            walk(sub)

    walk(filecmp.dircmp(src, DESKTOP_SKILL))
    return drift


def sync_desktop_skill():
    if DESKTOP_SKILL.exists():
        shutil.rmtree(DESKTOP_SKILL)
    shutil.copytree(ROOT / "skill", DESKTOP_SKILL)
    print("✓ app/skill/ 已同步（桌面壳打包用）")


def copy_app_files(dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    for f in APP_FILES:
        _copy(APP / f, dest / f)


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
    # 根跳转页以仓库根的 index.html 为唯一真源（它带着「考研总站」入口等站点级内容），
    # 脚本不再自己生成一份——两份并存会分叉。
    root_index = ROOT / "index.html"
    if root_index.exists():
        shutil.copy2(root_index, d / "index.html")
        print("✓ .pages-dist 已同步（根跳转页取自仓库根 index.html）")
    else:
        (d / "index.html").write_text(
            '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
            '<meta http-equiv="refresh" content="0;url=/app/"><title>DuoGrader</title></head>'
            '<body style="background:#f0f2f5;font-family:sans-serif;display:flex;align-items:center;'
            'justify-content:center;height:100vh;margin:0"><a href="/app/" style="color:#c4633f">进入 DuoGrader →</a></body></html>',
            encoding="utf-8",
        )
        print("! 仓库根没有 index.html，已生成兜底跳转页")
    print(f"✓ .pages-dist 已同步（{len(APP_FILES)} 文件 + skill + 跳转页）")


def sync_www(dest: Path, label: str):
    if dest.exists():
        for child in dest.iterdir():
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    copy_app_files(dest)          # 根路径布局：页面文件在 www 根
    sync_skill(dest)
    print(f"✓ {label} 已同步（根路径布局）")


def sync_apk_assets():
    assets = ROOT / "android" / "app" / "src" / "main" / "assets" / "public"
    assets.mkdir(parents=True, exist_ok=True)
    for child in assets.iterdir():
        if child.name in CAP_RUNTIME:
            continue
        shutil.rmtree(child) if child.is_dir() else child.unlink()
    copy_app_files(assets)
    sync_skill(assets)
    print("✓ APK assets 已同步（保留 capacitor 运行时文件）")


def sync_proxy_copies():
    for src, dst in PROXY_COPIES:
        _copy(src, dst)
        print(f"✓ 代理内核副本已同步: {dst.relative_to(ROOT)}")


def main():
    if not APP.exists():
        sys.exit("找不到 app/ 真源目录")
    if not PROXY.exists():
        sys.exit("找不到 proxy/ 真源目录")

    if CHECK_ONLY:
        drift = check_proxy_copies() + check_desktop_skill()
        if drift:
            for d in drift:
                print(f"[失败] {d}")
            print(f"副本漂移 {len(drift)} 处：跑 `python scripts/sync_app.py` 对齐")
            sys.exit(1)
        print("副本与真源一致（无漂移）")
        return

    sync_pages_dist()
    sync_www(ROOT / "www", "www（Capacitor webDir）")
    sync_apk_assets()
    sync_proxy_copies()
    sync_desktop_skill()
    print("全部副本已与真源对齐。提交后 CI（apk.yml）自动构建 APK。")


if __name__ == "__main__":
    main()
