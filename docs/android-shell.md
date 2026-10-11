# DuoGrader App（私有）

考研英语作文双评批改的安卓壳（Capacitor）。Web 资产在 `www/`，安卓工程在 `android/`。

推送到 main 自动构建 APK（GitHub Actions），产物在工作区 artifact `DuoGrader-debug-apk`。

- 依赖：JDK 17（CI 自带）+ npm install（Capacitor）
- 手动触发：Actions → Android APK Build → Run workflow
