## Why

`v0.0.1` 已在 GitHub 发布。当前工作区包含经过项目测试覆盖的功能、恢复机制、启动器与文档更新，需要以新的、可复现且可校验的补丁版本同步到 GitHub，避免继续使用或改写已发布的标签。

## What Changes

- 将 npm 根包、服务健康接口、Windows Launcher、发行目录和 GitHub Release 统一为 `0.0.2`。
- 新增中英文 `0.0.2` 更新日志，并更新两份 README 的版本入口、Windows 下载说明、`.xls` 路由说明、恢复边界与当前验证范围。
- 生成 Windows x64 ZIP 和 SHA-256 校验文件，推送 `main` 与轻量 `v0.0.2` 标签，并创建与更新日志一致的 GitHub Release。
- 归档已完成的 `release-0-0-1` 变更，并将其发行规格同步为主规格事实。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `release-artifacts`: 将发行标识、资产名和 GitHub Release 从 `0.0.1` 更新为 `0.0.2`。

## Impact

- 受影响文件包括 `package.json`、`package-lock.json`、`src/shared/app-info.js`、Launcher 项目和发行脚本、两份 README、两份更新日志、`.gitignore` 与 OpenSpec 工件。
- 不新增网络监听、第三方依赖、云服务或凭据存储；发布仍只面向当前 GitHub 仓库与 Windows x64 Launcher 资产。
