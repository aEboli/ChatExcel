## ADDED Requirements

### Requirement: 已启动本地服务具备受限自恢复

当 ChatExcel 通过项目启动脚本或 Launcher 启动后，系统 MUST 保持一个仅管理该项目 Node.js 服务的后台守护器。守护器 MUST 使用既有回环 HTTPS 健康检查确认服务就绪；受管服务退出或持续不健康时，守护器 SHALL 尝试按既有固定启动命令恢复服务。守护器 MUST NOT 读取模型凭据、提示词、工作簿内容或改变服务的网络监听边界。

#### Scenario: 服务退出后 Excel 重试重新加载
- **WHEN** 已成功启动的 ChatExcel Node.js 服务退出，随后守护器恢复健康检查，且用户在 Excel 宿主错误页点击“重试”
- **THEN** 任务窗格从既有本地 HTTPS 地址重新加载，且不会创建第二个监听服务

#### Scenario: 非本项目进程占用端口
- **WHEN** 服务不健康且 `127.0.0.1:3210` 已由不属于项目 PID 的进程监听
- **THEN** 守护器不得终止、接管或向该进程发送命令，并保留可诊断的端口冲突状态

### Requirement: 显式停止禁止自动恢复

`npm run stop:local` MUST 先停止本项目服务守护器，再在现有 PID 与监听端口校验通过时停止 Node.js 服务，并清理本项目运行时 PID/停止标记。停止流程完成后，守护器 MUST NOT 自动重新启动该服务。

#### Scenario: 用户主动停止服务
- **WHEN** 用户执行 `npm run stop:local`
- **THEN** 受管守护器和 Node.js 服务均已停止，后续不会因该次停止被自动拉起
