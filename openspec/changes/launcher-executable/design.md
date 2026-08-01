## Context

ChatExcel 已经有 `scripts/start.ps1`、`scripts/verify-certs.mjs` 和 `scripts/sideload.mjs`。这些脚本包含服务 PID/健康检查、证书检查和 Excel App Paths 定位逻辑，启动器应复用它们而不是重新实现一套侧载流程。

## Decisions

### 使用自包含 .NET 启动器编排现有脚本

`launcher/ChatExcelLauncher.cs` 编译为 Windows x64 self-contained single-file EXE。启动器不承担 Agent 逻辑，只负责启动子进程：

1. 解析自身目录下的 `app`，或开发仓库目录中的 `manifest.xml`。
2. 选择发行目录内 `app/runtime/node.exe`，否则使用系统 PATH 中的 Node.js。
3. 运行 `verify-certs.mjs`；证书缺失时调用 `office-addin-dev-certs/cli.js install`，再重新验证。
4. 运行 `start.ps1`。脚本已有服务复用、端口冲突和 HTTPS 健康检查。
5. 运行 `sideload.mjs`。脚本已有清单注册、临时工作簿生成和 Microsoft Excel App Paths 定位。

子进程全部使用隐藏窗口、显式工作目录和继承但优先插入运行时 Node 的 PATH。成功后启动器退出，Node 服务和 Excel 独立运行。

### 诊断和错误边界

`--diagnose` 只检查应用目录、Node、关键脚本、清单、依赖和证书状态，不启动服务、不注册清单、不打开 Excel。正常启动失败时只把命令名、退出码和截断后的标准错误写入 `%LOCALAPPDATA%\\ChatExcel\\launcher.log`，消息框只显示用户可操作的摘要。

### 发行目录结构

打包脚本输出：

```text
dist/ChatExcel Launcher/
  ChatExcel Launcher.exe
  app/
    assets/
    manifest.xml
    node_modules/             # express、smol-toml 与 Office 侧载依赖
    runtime/node.exe          # self-contained Node runtime
    scripts/
    src/
```

构建不把 `tests/`、`openspec/`、`.runtime/` 或用户配置复制到发行目录。发行目录中的 `app` 仍使用同一个 `%APPDATA%\\ChatExcel\\settings.json` 和用户级 Codex 配置路径。

## Risks / Trade-offs

- self-contained Node 与 .NET 启动器增加发行体积，但用户无需单独安装 Node.js 或 .NET。
- Office 开发证书首次安装可能触发 Windows 信任提示；启动器不会静默绕过系统安全确认。
- Excel 仍需要已安装的桌面版和可用的 Office.js 侧载能力；WPS 不会被启动器误当成 Excel。
