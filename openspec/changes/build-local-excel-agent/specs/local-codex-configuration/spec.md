## ADDED Requirements

### Requirement: 解析当前用户级 Codex 配置
系统 MUST 从 `CODEX_HOME/config.toml` 或用户目录下 `.codex/config.toml` 读取当前 `model_provider`、`model`、可选的 `model_reasoning_effort`、可选的 `model_verbosity` 和对应提供方配置，并且 MUST 仅接受 `wire_api = "responses"` 的提供方。

#### Scenario: 成功解析自定义 Responses 提供方
- **WHEN** 配置选择一个包含 `base_url`、`wire_api = "responses"` 和可用凭据的自定义提供方
- **THEN** 系统返回内部可用的模型、Responses URL 和认证信息

#### Scenario: 拒绝非 Responses 提供方
- **WHEN** 当前提供方缺少 `wire_api` 或其值不是 `responses`
- **THEN** 系统返回可识别的配置错误并且不发送模型请求

### Requirement: 支持安全的令牌来源
系统 MUST 支持从提供方的 `experimental_bearer_token` 或 `env_key` 指定的环境变量取得令牌，并且 MUST 在令牌不存在时失败关闭。

#### Scenario: 环境变量令牌不存在
- **WHEN** 提供方声明 `env_key` 但对应环境变量为空
- **THEN** 系统报告令牌未配置且不向提供方发送请求

### Requirement: 凭据保持在服务端
系统 MUST NOT 在任务窗格响应、静态资源、工作簿设置、浏览器存储或普通日志中返回或记录模型令牌。

#### Scenario: 查询脱敏配置状态
- **WHEN** Excel 任务窗格请求当前配置状态
- **THEN** 响应只包含提供方、模型、脱敏接口地址、协议和凭据是否存在，不包含令牌值

### Requirement: 配置变更自动生效
系统 SHALL 在每个模型步骤开始前重新读取配置文件，而不要求重新侧载 Excel 加载项。

#### Scenario: 会话中修改模型
- **WHEN** 用户在两次模型步骤之间修改 `config.toml` 中的模型
- **THEN** 下一次模型步骤使用新模型且状态接口反映新配置

### Requirement: 支持持久化自定义提供方
系统 SHALL 默认使用系统 Codex 配置，并 SHALL 允许用户在设置页切换为 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 或 Google Gemini generateContent 自定义提供方。系统 MUST 把模式开关、1 到 1000 的最大步骤数和自定义非密钥字段持久化到 `%APPDATA%\ChatExcel\settings.json`，并 MUST 使用 Windows 当前用户 DPAPI 加密 API Key 后再写入磁盘。明文或密文 API Key MUST NOT 返回任务窗格、浏览器存储或普通日志。

#### Scenario: 保存自定义提供方
- **WHEN** 用户关闭系统配置并提交有效协议、API 根地址、API Key、模型 ID、上下文长度和思考等级
- **THEN** 下一条模型消息使用自定义提供方，脱敏状态不包含 API Key，服务重启后恢复相同自定义配置和模式

#### Scenario: 切换系统配置后恢复自定义配置
- **WHEN** 用户已有有效自定义配置，开启系统 Codex 配置后再次关闭开关
- **THEN** 系统恢复此前保存的协议、API 根地址、凭据、模型和参数，不要求重新填写或获取模型

#### Scenario: 持久化密钥无法解密
- **WHEN** 设置文件中的 DPAPI 密文损坏或不属于当前 Windows 用户
- **THEN** 系统把自定义凭据标记为未配置并拒绝模型请求，不返回密文或回退到不安全存储

#### Scenario: 自定义配置无效
- **WHEN** API URL、API Key、模型 ID 或上下文长度无效
- **THEN** 系统拒绝切换且继续保留之前的有效配置

#### Scenario: 重启后恢复最大步骤数
- **WHEN** 用户把最大步骤数保存为 250 后关闭并重新启动本地服务
- **THEN** 设置页与后续新会话继续使用 250，不因系统或自定义配置开关改变而丢失

### Requirement: 发现模型并映射思考等级
系统 SHALL 按所选协议从自动组成的模型端点发现模型 ID，任务窗格 MUST 只允许选择已发现模型或当前有效模型；系统 SHALL 优先读取提供方声明的思考等级，否则使用模型族和协议的保守映射。

#### Scenario: 获取包含思考元数据的模型
- **WHEN** `/models` 返回模型 ID 和支持的思考等级
- **THEN** 设置页列出该模型 ID，输入区只提供对应思考等级

#### Scenario: 提供方不返回思考元数据
- **WHEN** `/models` 只返回模型 ID
- **THEN** 系统返回标明来源为推断的保守思考等级映射，不声称它来自提供方

### Requirement: 从 API 根地址组成协议端点
系统 MUST 接受不含版本和方法路径的 HTTP 或 HTTPS API 根地址，并 MUST 按协议自动组成生成端点与模型发现端点。系统 SHALL 兼容用户粘贴带末尾斜杠、已知 `/v1`、`/v1beta` 或完整已知端点的地址并规范化为同一根地址。

#### Scenario: OpenAI 根地址
- **WHEN** 用户为 OpenAI Responses 输入 `https://api.openai.com`
- **THEN** 系统使用 `https://api.openai.com/v1/responses` 生成内容并使用 `https://api.openai.com/v1/models` 获取模型

#### Scenario: Gemini 根地址
- **WHEN** 用户为 Google Gemini 输入 `https://generativelanguage.googleapis.com/`
- **THEN** 系统使用 `/v1beta/models/{model}:generateContent` 生成内容并使用 `/v1beta/models` 获取模型

#### Scenario: 保留网关前缀路径
- **WHEN** 用户输入 `https://gateway.example/team/openai/v1`
- **THEN** 系统保留 `/team/openai` 前缀并只规范化已知版本后缀
