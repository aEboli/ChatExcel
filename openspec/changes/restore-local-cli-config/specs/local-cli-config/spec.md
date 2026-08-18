## Purpose

让 ChatExcel 在不暴露本机凭据的前提下复用用户已经配置好的 Codex CLI 或 Claude CLI，并在两个来源均不可用时提供可诊断的失败状态。

## ADDED Requirements

### Requirement: System CLI sources

The system SHALL provide automatic, Codex CLI, and Claude CLI sources. 自动来源必须优先使用可用的 Codex CLI 配置，并仅在其不可用时尝试 Claude CLI；显式来源不得静默切换到另一个来源。

#### Scenario: Codex CLI is selected

- **WHEN** 用户选择 Codex CLI 且用户级 `config.toml` 与凭据可用
- **THEN** 服务使用 Codex 模型、端点和凭据，公开状态标记当前来源为 Codex CLI

#### Scenario: Auto falls back to Claude CLI

- **WHEN** 用户选择自动来源、Codex 配置不可用且 Claude CLI `settings.json` 有效
- **THEN** 服务使用 Claude Anthropic Messages 配置，不要求用户把令牌重新填写到 Excel

#### Scenario: Explicit source fails closed

- **WHEN** 用户显式选择的 CLI 配置缺失、格式错误或令牌缺失
- **THEN** 服务返回稳定的配置错误，且不使用另一个 CLI 来源的凭据

### Requirement: Local credential boundary

The system SHALL read and use CLI tokens only in the local Node.js service; 配置接口、任务窗格状态、日志和错误消息不得包含令牌或完整配置原文。

#### Scenario: Public configuration state

- **WHEN** Excel WebView 请求当前配置
- **THEN** 响应只包含来源、脱敏端点、模型和 `credentialConfigured`，不包含任何令牌

#### Scenario: CLI auth file

- **WHEN** Codex provider 声明 `requires_openai_auth=true`
- **THEN** 服务可以读取同一 Codex 目录的 `auth.json.OPENAI_API_KEY`，并在公开响应中只报告凭据已配置
