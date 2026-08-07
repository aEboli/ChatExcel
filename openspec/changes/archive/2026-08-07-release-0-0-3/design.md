## Context

`v0.0.2` 已是 GitHub 上不可变的标签和可下载资产。此后 `main` 增加了图片输入、模型能力与思考控制、工作簿修改保护，以及紧凑任务窗格布局；当前 Windows ZIP、版本徽章和下载说明仍指向旧版本。根 `package.json` 是构建脚本的发行版本来源，构建会把该值传入 Launcher、`release.json` 和 ZIP 文件名。

## Goals / Non-Goals

**Goals:**

- 以 `0.0.3` 作为 npm、Launcher、`release.json`、ZIP、Git 标签和 GitHub Release 的唯一发行标识。
- 用双语文档和更新日志准确说明已验证变更与仍需真实 Excel 验收的边界。
- 生成、校验并上传 Windows x64 ZIP 与 SHA-256 资产。

**Non-Goals:**

- 不改写或删除 `v0.0.1`、`v0.0.2` 标签、Release 或资产。
- 不改变 Office 清单独立的 `1.0.0.0` 版本、网络监听、协议适配、DPAPI 保护或令牌边界。
- 不把未完成的原生 `.xls` 工作、桌面 Excel 长流取消或 Marketplace 发布描述为本次已完成能力。

## Decisions

- **使用补丁版本 `0.0.3`。** 已发布标签不可复用；补丁发布保留可追溯的源码、资产和校验历史。
- **从根 npm 元数据驱动构建。** 构建脚本从 `package.json` 读取版本并向 Launcher 传递版本属性；同时同步项目文件中的默认版本，避免开发构建和发布构建出现误导性差异。
- **以双语 changelog 为发布事实来源。** README 更新下载入口并展示紧凑任务窗格，Release 正文复用已验证的英文更新摘要；不把未通过桌面 Excel 实测的行为写成完成。
- **先验证资产，再推送标签和上传。** 本地检查代码、规格、Launcher、ZIP 内容和 SHA-256；只在成功后提交、推送、打标签并创建 GitHub Release。

## Risks / Trade-offs

- [Risk] 版本链漏改导致下载资产与源码不一致 → 通过全仓版本搜索、构建后的 `release.json`、EXE 元数据和 ZIP 名称交叉核验。
- [Risk] 构建输出或运行时数据被提交 → `dist/` 与运行时目录继续由 `.gitignore` 排除，暂存前审阅文件列表与缓存差异。
- [Risk] GitHub 上传中断导致 Release 不完整 → 先推送已验证的发布提交和标签；上传失败时保留不可变标签和本地资产，以相同资产重试，不改写历史。
- [Risk] 自动化检查不能覆盖 Excel 宿主行为 → Release 与 README 明确保留真实桌面 Excel、长流停止和 `.xls` 兼容性验收缺口。

## Migration Plan

1. 更新版本元数据、主规格、README 和 changelog，生成 `0.0.3` 资产。
2. 运行代码、清单、Launcher、OpenSpec 和资产验证，确认 ZIP 与 SHA-256 一致。
3. 提交并推送 `main`，创建并推送轻量标签 `v0.0.3`。
4. 创建 GitHub Release、上传 ZIP 与 SHA-256，并读取远端提交、标签、Release 和资产进行复核。

如需回滚，只通过后续补丁版本修复；不重写已发布版本。

## Open Questions

无。
