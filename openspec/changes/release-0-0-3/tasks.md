## 1. 发行元数据与文档

- [x] 1.1 将 npm、Launcher 和发行规格的版本更新为 `0.0.3`，并确认 Office 清单版本保持独立。
- [x] 1.2 更新双语 README、双语 changelog 和紧凑任务窗格截图引用，准确描述发布内容与验收边界。

## 2. 构建与验证

- [x] 2.1 运行 JavaScript 检查、全量 Node 测试、清单校验、依赖审计和 Launcher 构建。
- [x] 2.2 生成 `0.0.3` Windows x64 ZIP 与 SHA-256，校验版本、EXE 元数据、ZIP 内容和哈希。
- [x] 2.3 运行严格 OpenSpec 校验、版本搜索和 `git diff --check`，确认规格、文档和发行元数据一致。

## 3. GitHub 发布

- [ ] 3.1 审阅暂存内容，提交并推送当前 `main`，创建并推送 `v0.0.3` 标签。
- [ ] 3.2 创建 GitHub Release，上传 ZIP 与 SHA-256，并读取远端提交、标签、Release 和资产进行复核。
