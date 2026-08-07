## Why

GitHub 当前最新可下载发行版仍为 `v0.0.2`，但 `main` 已包含图片输入、能力安全的思考控制、工作簿修改保护和紧凑任务窗格等已验证改动。需要发布一个新的、可校验的 Windows x64 资产，让源码、文档、标签与用户下载内容保持一致。

## What Changes

- 将 npm 根包、Launcher、`release.json`、ZIP、Git 标签和 GitHub Release 统一更新为 `0.0.3`。
- 更新中英文 README 与更新日志，说明自 `v0.0.2` 以来已验证的图片输入、模型能力控制、工作簿保护和紧凑任务窗格体验。
- 构建 Windows x64 ZIP 与 SHA-256 校验文件，推送 `main` 和 `v0.0.3`，并创建对应 GitHub Release。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `release-artifacts`: 将发布标识、可下载资产名称和 GitHub Release 从 `0.0.2` 更新为 `0.0.3`。

## Impact

- 影响 `package.json`、`package-lock.json`、Launcher 项目、双语 README、双语更新日志、发行规格及 GitHub Release 资产。
- 不新增网络监听、依赖、云服务或凭据存储；本地令牌仍不进入 Excel WebView，也不涉及 Microsoft Marketplace 发布。
