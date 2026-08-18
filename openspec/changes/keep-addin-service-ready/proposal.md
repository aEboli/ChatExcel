## Why

ChatExcel 的 Office.js 清单加载 `https://localhost:3210/taskpane.html`。用户重启 Windows 后直接从 Excel 的“加载项”打开 ChatExcel 时，本地服务尚未启动，Excel 会在任务窗格脚本执行前报告“加载加载项时出错”。Office.js 页面无法在自身尚未加载时启动本机进程，因此需要在当前用户登录后预先恢复既有服务监督器。

## What Changes

- 新增当前用户级 ChatExcel 服务启动项管理脚本；登录后只启动或复用既有本地服务，不打开 Excel、不重新旁加载清单。
- 源码首次安装在证书、清单、服务和旁加载全部成功后注册启动项；源码卸载只删除仍然精确指向当前项目的启动项。
- Windows 发行 Launcher 在默认或现代工作簿启动成功后，把自身的 `--service-only` 模式注册为当前用户启动项。
- 将 Office 清单和原生 `.xls` 伴随窗格统一指向服务实际监听的 `https://127.0.0.1:3210`，避免 Windows 把 `localhost` 优先解析到未监听的 IPv6 地址。
- 任务窗格首次读取本地配置时，对登录启动期间的短暂网络竞态执行有界重试，不把永久配置错误伪装成成功。
- 增加临时注册表夹具、安装/卸载接线和 Launcher 资源边界测试，并补充中英文使用说明。

## Capabilities

### New Capabilities

- `local-service-autostart`: 当前用户登录后恢复 ChatExcel 本地服务，使 Excel 加载项入口可直接打开任务窗格。

### Modified Capabilities

无。

## Impact

- 影响源码安装/卸载脚本、Windows Launcher 编排、Office 清单、本地服务地址常量、发行资源校验、测试和双语 README。
- 只写入当前 Windows 用户的 `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`；不创建系统服务、不要求管理员权限、不改变回环监听、凭据或工作簿数据边界。
- 不把实验性的原生加载项作为生产入口，也不改变 Microsoft Marketplace 发布范围。
