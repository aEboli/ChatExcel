## Why

当前 ChatExcel 需要用户分别运行本地服务、检查开发证书和执行 Excel 侧载命令。对于只想使用加载项的用户，这个流程暴露了 Node.js、PowerShell 和开发依赖，容易漏步骤或误用 WPS。

## What Changes

- 增加 Windows `ChatExcel Launcher.exe`，双击后自动定位应用目录、验证或安装本地 Office 开发证书、启动或复用本地服务，并通过现有侧载脚本显式启动 Microsoft Excel。
- 启动器失败时显示不包含密钥或工作簿内容的可操作错误，并把诊断信息写入用户级 `%LOCALAPPDATA%\\ChatExcel\\launcher.log`。
- 增加 `--diagnose` 无副作用诊断模式，用于验证发行目录中的 Node、脚本、清单和证书条件。
- 增加打包脚本，生成包含自包含 Windows x64 Node 运行时、最小生产/侧载依赖和应用资源的独立发行目录。
- 更新中英文 README，说明一键加载、首次证书信任提示、停止服务和发行目录结构。

## Boundaries

- 启动器只允许回环地址服务，继续使用 `https://localhost:3210`，不改变服务的 Host/Origin 校验或网络暴露边界。
- 启动器不读取、写入或记录 Codex API Key、提示词、工具结果、工作簿数据或图片附件。
- 不替换现有 Node 服务、Office.js 任务窗格、清单和侧载实现；启动器只编排它们。
- 发行版目标为 Windows x64 Microsoft Excel 桌面版；不支持 WPS 作为侧载宿主。
