# 本地加载项运行时规格

## Purpose

定义 Excel 任务窗格本地 HTTPS 服务的网络边界、状态接口、侧载流程和会话数据生命周期，确保模型凭据与工作簿任务数据始终留在受控的本机运行边界内。

## Requirements

### Requirement: 仅在回环地址托管
本地服务 MUST 只监听 `127.0.0.1`，并 SHALL 通过受信任的本地 HTTPS 端点向 Excel 提供任务窗格和 API。

#### Scenario: 从非回环接口访问
- **WHEN** 客户端尝试通过非回环网络接口连接服务
- **THEN** 服务不可达且不会暴露任务窗格或模型接口

### Requirement: 限制浏览器来源和请求形状
服务 MUST 校验允许的 `Host` 和 `Origin`，MUST 限制 JSON 请求体大小，并且 MUST NOT 提供可转发任意目标的通用代理接口。

#### Scenario: 未授权网页调用 Agent API
- **WHEN** 非任务窗格来源向 Agent API 发送请求
- **THEN** 服务返回拒绝响应且不读取工作簿数据或调用模型

### Requirement: 提供健康和脱敏状态
服务 SHALL 提供不需要令牌的健康检查和脱敏配置状态，以区分服务、配置和上游提供方故障。

#### Scenario: 服务运行但配置无效
- **WHEN** HTTPS 服务可访问但 Codex 配置缺少有效提供方
- **THEN** 健康检查保持可用且配置状态返回明确的无效状态

### Requirement: 支持可重复侧载与移除
项目 SHALL 提供安装依赖、安装开发证书、启动服务、验证清单、侧载 Excel、注销清单和移除证书的中文命令。

#### Scenario: 全新 Windows 环境侧载
- **WHEN** 用户按照文档在具备 Node.js 和 Microsoft Excel 的环境执行安装流程
- **THEN** Excel 功能区出现加载项入口且任务窗格能显示当前脱敏模型状态

#### Scenario: 工作簿默认关联到 WPS
- **WHEN** Windows 的 `.xlsx` 默认文件关联不是 Microsoft Excel
- **THEN** 侧载命令仍通过系统 App Paths 显式启动 Microsoft Excel 并打开开发侧载工作簿

#### Scenario: 移除加载项
- **WHEN** 用户执行注销和停止命令
- **THEN** Excel 不再加载该任务窗格且已有工作簿仍可正常打开

### Requirement: 不持久化任务数据
服务和任务窗格 MUST NOT 默认把提示词、工具结果或工作簿内容写入磁盘或发送遥测。

#### Scenario: 停止本地服务
- **WHEN** 用户停止本地服务并关闭任务窗格
- **THEN** 本次会话的提示词、工具结果和工作簿片段不留在项目数据文件中

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
