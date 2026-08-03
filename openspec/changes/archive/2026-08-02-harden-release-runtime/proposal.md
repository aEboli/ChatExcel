## Why

当前实现的启动守护、恢复快照、提供方协议适配和原生 `.xls` 宿主存在可复现的跨进程竞态、错误成功化和跨工作簿影响风险；发行产物也可能把新静态资源连接到旧服务进程。必须在不扩大本地凭据和工作簿数据边界的前提下，使这些运行时边界可验证且失败关闭。

## What Changes

- 让本地服务的健康检查、守护、停止和启动脚本校验回环监听归属、受管进程身份及发行版本/能力，而非仅接受任意 `ok` 响应。
- 使恢复快照的过期清理与原子替换跨进程安全；在任务窗格本地 SSE 中断、清除失败、工作簿保存/另存为和原生 `.xls` 重启时保留或明确拒绝恢复，绝不静默丢失可恢复会话。
- 为四种提供方统一执行认证信息脱敏和严格终态协议校验，并完整保留 Anthropic thinking 签名与 redacted thinking 以支持工具续传。
- 将原生 `.xls` 操作严格限定在 Launcher 打开的工作簿，保护大范围数字格式、混合格式读取、表格创建回滚、Excel/WebView 生命周期及 smoke 输入文件。
- 让 Launcher 构建失败立即失败，并从 `package.json` 将版本一致传递到程序集、健康接口和发行包。
- 修复任务窗格对失败写入的历史预览呈现，避免把未执行的矩阵显示为已写入。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `local-addin-runtime`: 健康检查、受管服务所有权、回环监听和显式停止必须验证版本、能力与进程身份。
- `local-conversation-recovery`: 快照清理、恢复绑定和任务窗格断线/清除失败必须跨进程安全且可恢复。
- `provider-connection-recovery`: 无效完成响应必须失败关闭，不得作为可重连或成功的空回答。
- `responses-agent-orchestration`: 提供方错误摘要必须统一脱敏，Anthropic 连续 thinking 工具续传必须保留签名和 redacted 内容。
- `excel-workbook-automation`: 原生 `.xls` 工具必须隔离到绑定工作簿，并在格式、表格和生命周期错误中保留用户数据。
- `taskpane-experience`: 恢复状态和历史预览必须如实反映传输及工具执行结果。
- `release-artifacts`: Launcher、服务健康状态和发行包必须由同一版本来源构建，且依赖或发布失败不得产生可用假象。

## Impact

- 受影响代码：`scripts/`、`src/server/`、`src/taskpane/`、`launcher/`、`tests/`、`tests/native-smoke/` 与相应 OpenSpec 主规格。
- 不增加第三方依赖，不改变服务仅监听 `127.0.0.1`、模型令牌仅存在本地服务端或用户数据不离开本机的边界。
- Launcher 的健康协议与运行时 PID 元数据会扩展为可核验的结构化状态；旧的、不匹配版本的常驻服务将被明确报告而不会被新发行物当作就绪服务。
