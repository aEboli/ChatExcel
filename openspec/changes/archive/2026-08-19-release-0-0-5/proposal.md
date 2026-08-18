## Why

`v0.0.4` 已经是不可变的 GitHub 正式发行，但当前 `main` 还包含三项尚未打包的用户可见修复：登录后保持本地服务就绪、Office 入口统一连接服务实际监听的 IPv4 回环地址，以及登录启动期间的有界配置重试。需要以新的可校验 Windows x64 发行包同步源码、文档、版本元数据、Git 标签和 GitHub Release。

## What Changes

- 将 npm 根包、Launcher 默认程序集版本、双语 README、双语更新日志和发行规格更新为 `0.0.5`。
- 构建 `ChatExcel-Launcher-0.0.5-win-x64.zip` 及匹配的 SHA-256 文件。
- 推送 `main` 与 `v0.0.5` 标签，并创建对应的 GitHub Release 和两个发行资产。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `release-artifacts`: 将发布标识、可下载资产名称和 GitHub Release 从 `0.0.4` 更新为 `0.0.5`。

## Impact

- 影响 Launcher 项目、版本测试、双语 README、双语更新日志、发行规格、发行资产和 GitHub Release。
- 不改变现有工作簿操作、提供方协议、凭据保护或 Microsoft Marketplace 发布范围。
- 提交仅显式暂存本次改动文件；工作树中无关的历史 OpenSpec 删除不得进入提交或发行包。
