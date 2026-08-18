## Purpose

保证系统配置故障不会把设置页变成不可修复状态，用户始终可以看到并提交自定义 API 配置或重新选择本机 CLI 来源。

## ADDED Requirements

### Requirement: Repairable settings form

The settings page SHALL remain repairable when system configuration loading fails: 齿轮入口保持可用，默认显示自定义 API 字段，并提供系统 CLI 来源选择；提交自定义配置的行为必须与正常配置状态一致。

#### Scenario: Red configuration state

- **WHEN** `/api/config` 返回配置错误且用户点击齿轮
- **THEN** 设置页打开，自定义 API URL、API Key、协议和模型控件可见，系统开关默认关闭

#### Scenario: System source selection

- **WHEN** 用户选择 Codex CLI 或 Claude CLI 并保存系统配置
- **THEN** 选择被持久化，下一次打开设置页显示相同来源并由服务加载该来源

#### Scenario: Custom API fallback

- **WHEN** 系统配置不可用且用户填写自定义 API、获取模型后保存
- **THEN** 服务切换到自定义来源，API key 按现有 Windows DPAPI 规则保存，页面不显示明文 key
