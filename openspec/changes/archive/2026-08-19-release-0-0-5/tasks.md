## 1. 发行元数据与文档

- [x] 1.1 将根包、锁文件、Launcher 默认版本、双语 README、双语更新日志和发行规格同步为 `0.0.5`。
- [x] 1.2 更新版本同步回归断言。

## 2. 构建与验证

- [x] 2.1 运行 JavaScript 检查、完整 Node 测试、清单校验、Launcher 构建和目标 OpenSpec 严格校验。
- [x] 2.2 从隔离工作树生成 Windows x64 ZIP 与 SHA-256，校验 EXE 元数据、`release.json`、ZIP 内容、哈希和 `--diagnose` 行为。

## 3. GitHub 发布

- [x] 3.1 审阅显式暂存内容，确认无删除项，提交并推送 `main`，创建并推送 `v0.0.5` 标签。
- [x] 3.2 创建 GitHub Release，上传 ZIP 与 SHA-256，并读取远端提交、标签、Release 和资产进行复核。
