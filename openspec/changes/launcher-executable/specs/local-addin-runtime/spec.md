## ADDED Requirements

### Requirement: 提供一键 Windows 启动器

项目 SHALL 提供 Windows x64 `ChatExcel Launcher.exe`，能够从发行目录定位应用资源，验证或安装本地开发证书，启动或复用回环服务，并调用现有 Excel 侧载流程。

#### Scenario: 首次双击启动

- **WHEN** 用户在已安装 Microsoft Excel 的 Windows x64 机器上双击 Launcher，且本地证书尚未安装
- **THEN** 启动器提示并完成证书安装，启动 `https://localhost:3210` 服务，注册清单并通过 Excel 可执行文件路径打开加载项

#### Scenario: 服务已运行

- **WHEN** 用户再次双击 Launcher 且 ChatExcel 服务健康
- **THEN** 启动器复用现有服务，不启动第二个监听进程，仍可执行一次清单侧载并打开 Microsoft Excel

#### Scenario: 诊断发行目录

- **WHEN** 用户运行 `ChatExcel Launcher.exe --diagnose`
- **THEN** 启动器只检查 Node、关键资源、清单和证书状态，不启动服务、不注册加载项、不打开 Excel

### Requirement: 启动器保持本地安全边界

启动器 MUST 只调用项目固定脚本和固定的本地 Node 运行时，MUST NOT 接受任意 URL、命令或脚本参数；日志和错误对话框 MUST NOT 包含 API Key、提示词、工具结果、工作簿内容或图片附件。

#### Scenario: 缺少依赖

- **WHEN** 发行目录缺少 Node、清单或侧载依赖
- **THEN** 启动器停止流程并显示修复提示，不启动不完整服务，也不打开 Excel
