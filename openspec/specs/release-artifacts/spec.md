# release-artifacts Specification

## Purpose
定义 ChatExcel Windows x64 Launcher 的可复现发行元数据、可校验资产和 GitHub Release 对应关系。
## Requirements
### Requirement: 发行元数据与 GitHub 资产一致

发行流程 SHALL 使用 `0.0.3` 作为 npm 根包、服务健康接口、Launcher `release.json`、Git 标签和 GitHub Release 的版本标识，并 SHALL 提供可校验的 Windows x64 发行包。

#### Scenario: 生成发行包

- **WHEN** 维护者运行 `npm run build:launcher` 或 `npm run package:release`
- **THEN** `release.json` 的 `version` 为 `0.0.3`，发行目录包含可执行 Launcher、内置 Node.js 和最小侧载依赖，ZIP 名称为 `ChatExcel-Launcher-0.0.3-win-x64.zip`

#### Scenario: 校验发布资产

- **WHEN** 维护者下载 GitHub Release 的 ZIP 和 SHA-256 文件
- **THEN** 校验值匹配，解压后可运行 `ChatExcel Launcher.exe --diagnose` 且不会启动服务或 Excel

### Requirement: 发行版本由单一来源生成
`npm run build:launcher` 和 `npm run package:release` MUST 从根 `package.json` 的版本生成 Launcher 的程序集版本、文件版本、健康接口版本、`release.json` 和 ZIP 文件名。构建产物的可执行文件版本 MUST 与同一发行目录的 `release.json` 相匹配。

#### Scenario: 发布新补丁版本
- **WHEN** 维护者将 `package.json` 更新为新的有效发行版本并构建 Launcher
- **THEN** 发布 EXE 的产品/文件版本、健康接口和 `release.json` 均以该版本为准，且 ZIP 文件名包含该版本

### Requirement: 发行构建和 smoke 不得伪造成功或修改输入
构建脚本 MUST 检查依赖安装和 `dotnet publish` 的退出码，任何失败时不得留下可发布的成功目录。原生 smoke MUST 在唯一临时副本上执行保存操作，并在结束后验证用户提供的原始 `.xls` 文件内容未变。

#### Scenario: 依赖安装或发布失败
- **WHEN** `npm install` 或 `dotnet publish` 返回非零退出码
- **THEN** 构建流程以失败状态退出，不生成或保留看似完整的发行产物

#### Scenario: 对用户 XLS 运行原生 smoke
- **WHEN** 维护者把现有 `.xls` 路径传给 native smoke
- **THEN** smoke 只写入临时副本，原始文件在运行前后的哈希相同
