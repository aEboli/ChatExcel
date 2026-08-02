## ADDED Requirements

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

### Requirement: 提供当前模型提供方连通性探测
服务 MUST 提供只接受受信任同源任务窗格 JSON 请求的当前模型提供方连通性接口。接口 SHALL 使用服务端当前有效配置访问协议对应的模型目录端点，并且 MUST NOT 接受前端提交的 URL、模型、提示词或凭据。

#### Scenario: 当前提供方连通
- **WHEN** 受信任任务窗格请求当前模型提供方连通性且模型目录端点在短超时内返回有效成功响应
- **THEN** 服务返回脱敏的 `connected` 状态，不生成模型内容、不发送工作簿数据且不修改持久化配置

#### Scenario: 当前提供方不可达
- **WHEN** 模型目录端点网络不可达、超时、认证失败、限流、返回非成功状态或无效响应
- **THEN** 服务返回脱敏的 `failed` 状态和稳定错误代码，不返回上游正文、接口地址或凭据

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
- **WHEN** 用户停止服务并关闭任务窗格
- **THEN** 本次会话的提示词、工具结果和工作簿片段不留在项目数据文件中

### Requirement: 持久化配置与凭据隔离
服务 SHALL 允许把配置来源开关、协议、API 根地址、模型参数和加密后的自定义凭据写入 `%APPDATA%\ChatExcel\settings.json`，但 MUST NOT 把提示词、工具结果、工作簿内容或图片附件写入该文件。自定义凭据 MUST 使用 Windows 当前用户 DPAPI 保护。

#### Scenario: 服务重启恢复配置
- **WHEN** 用户保存自定义配置后停止并重新启动本地服务
- **THEN** `/api/config` 返回相同的脱敏配置和配置来源开关，后续模型请求可使用解密后的凭据

#### Scenario: 持久化文件不包含任务数据
- **WHEN** 用户完成一条带工作簿上下文和图片的任务
- **THEN** 设置文件只包含配置字段和 DPAPI 密文，不包含任务文字、工具结果、工作簿值或图片 data URL
