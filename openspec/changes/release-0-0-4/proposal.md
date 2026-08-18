## Why

`main` 已包含 `v0.0.4` 的已验证源码更新，但 GitHub 的最新可下载资产仍为 `v0.0.3`。需要发布一个可校验的 Windows x64 启动器，使源码、文档、版本元数据、Git 标签和用户下载内容一致。

## What Changes

- 将 Launcher 默认版本、双语 README、双语更新日志和发行规格更新为 `0.0.4`。
- 修复 Launcher 错误处理的局部变量作用域，解除 Windows x64 发行构建阻断。
- 构建 `ChatExcel-Launcher-0.0.4-win-x64.zip` 及匹配的 SHA-256 文件。
- 推送 `main` 与 `v0.0.4` 标签，并创建对应的 GitHub Release 和两个发行资产。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `release-artifacts`: 将发布标识、可下载资产名称和 GitHub Release 从 `0.0.3` 更新为 `0.0.4`。

## Impact

- 影响 Launcher 项目、双语 README、双语更新日志、发行规格、发行测试和 GitHub Release 资产。
- 不新增依赖、网络监听、云服务或凭据存储；本地令牌不会进入 Excel WebView，也不涉及 Microsoft Marketplace 发布。
