## ADDED Requirements

### Requirement: 前端图片附件沿既有协议发送

任务窗格 MUST 把已验证图片作为现有用户消息 `attachments` 传给本地 Agent API；服务端 MUST 继续把它规范化为 `input_image` 并按所选协议转换为对应图片内容，不得新增前端直连提供方路径。

#### Scenario: 文本和图片一起发送

- **WHEN** 用户提交一条包含任务文字和一张有效图片的消息
- **THEN** 本地服务收到文字与附件并向模型发送对应的文本和图片内容

#### Scenario: 仅图片发送

- **WHEN** 用户没有输入文字但已添加有效图片并提交
- **THEN** 任务窗格允许发送，服务端按既有附件校验处理该请求
