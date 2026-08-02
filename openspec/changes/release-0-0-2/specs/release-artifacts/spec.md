## MODIFIED Requirements

### Requirement: 发行元数据与 GitHub 资产一致

发行流程 SHALL 使用 `0.0.2` 作为 npm 根包、服务健康接口、Launcher `release.json`、Git 标签和 GitHub Release 的版本标识，并 SHALL 提供可校验的 Windows x64 发行包。

#### Scenario: 生成发行包

- **WHEN** 维护者运行 `npm run build:launcher` 或 `npm run package:release`
- **THEN** `release.json` 的 `version` 为 `0.0.2`，发行目录包含可执行 Launcher、内置 Node.js 和最小侧载依赖，ZIP 名称为 `ChatExcel-Launcher-0.0.2-win-x64.zip`

#### Scenario: 校验发布资产

- **WHEN** 维护者下载 GitHub Release 的 ZIP 和 SHA-256 文件
- **THEN** 校验值匹配，解压后可运行 `ChatExcel Launcher.exe --diagnose` 且不会启动服务或 Excel
