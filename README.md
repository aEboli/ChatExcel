# ChatExcel

<div align="center">
  <img src="assets/icon-80.png" alt="ChatExcel" width="80" height="80" />
  <h1>ChatExcel</h1>
  <p><strong>A local-first AI copilot for Microsoft Excel</strong></p>
  <p>Inspect the workbook, reason over the active sheet, and make controlled edits without leaving Excel.</p>
  <p>
    <a href="https://github.com/aEboli/ChatExcel/releases/tag/v0.0.2"><img src="https://img.shields.io/github/v/release/aEboli/ChatExcel?display_name=tag&sort=semver&label=release" alt="Release 0.0.2" /></a>
    <a href="https://github.com/aEboli/ChatExcel"><img src="https://img.shields.io/github/stars/aEboli/ChatExcel?style=flat&label=stars" alt="GitHub stars" /></a>
    <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.0.2-107c41" alt="Version 0.0.2" /></a>
    <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/中文-README-1967a6" alt="中文 README" /></a>
  </p>
</div>

<p align="center">
  <img src="assets/screenshots/taskpane-400x900.png" alt="ChatExcel task pane preview" width="400" />
</p>

<p align="center"><sub>Windows · Microsoft Excel desktop · local HTTPS · four streaming protocols</sub></p>

<div align="center">

| Local-first | Auditable edits | Streaming | One-click launcher |
| --- | --- | --- | --- |
| Reuse the current Codex setup or use a local gateway | Read automatically, approve mutations explicitly | Responses, Chat Completions, Messages, Gemini | Self-contained Windows x64 distribution |

</div>

**Release:** [v0.0.2](https://github.com/aEboli/ChatExcel/releases/tag/v0.0.2) · [Changelog](CHANGELOG.md) · [中文说明](README.zh-CN.md)

## What It Solves

Excel users often need to move between a model client and a workbook to inspect ranges, write formulas, format cells, or create charts. Cloud-only add-ins cannot read a local Codex setup, while a raw API chat cannot safely operate on the active workbook.

ChatExcel places the agent beside the sheet and gives it a narrow, auditable Excel tool surface. Read operations can run automatically. Workbook mutations are either individually approved or explicitly announced before automatic execution, depending on the mode selected in the composer.

## Why This Release

`0.0.2` adds encrypted current-workbook crash recovery, supervised local-service recovery, correlated tool-error repair, read-only history previews, and a native companion path for existing `.xls` workbooks while keeping the original legacy file format under Excel's control.

## Core Workflow

1. Open the ChatExcel task pane from the `ChatEx` ribbon group.
2. Enter a workbook task.
3. Select the model, reasoning level, context indicator, and approval mode at the bottom of the pane.
4. ChatExcel sends only the current task context and registered Excel tool definitions to the selected provider.
5. The pane groups all tool actions from one task above the conversation, reports the actual operation before its success or failure state, and appends assistant text as stream deltas arrive.
6. If a model produces an invalid tool name, argument, or range, ChatExcel rejects that call without touching the workbook, returns a structured error to the model, and lets the agent correct itself.
7. The agent continues through a local in-memory session until it finishes, is stopped, or reaches the configured step limit (100 by default).

## Features

- Workbook-aware label showing `file-name-sheet-name`.
- Read, write, formula, formatting, number-format, autofit, clear, worksheet, table, chart, and sort tools.
- Common A1 addresses including cells, rectangular ranges, absolute references, whole columns such as `N:R`, and whole rows such as `1:3`.
- Automatic recovery from correlated model tool errors across Responses, Chat Completions, Anthropic Messages, and Gemini.
- Compact, collapsible activity history above the conversation.
- One task-level activity group containing every tool step, collapsed by default with step-name previews.
- Historical context view with confirmation guards before continuing or accepting manual workbook edits.
- `Needs approval` and `No approval` modes with distinct visual states.
- One-line growing text composer with compact model, reasoning, context, approval, and send controls.
- Streaming assistant output for four protocols, with complete tool arguments validated before any Excel tool runs.
- A single send control that becomes a spinner while running and reveals the stop action on hover or keyboard focus.
- Settings page with system Codex toggle, protocol selection, model discovery, context length, reasoning mapping, and a configurable maximum of 1-1000 model steps (default 100).
- Small glass-style interface with restrained transitions and `prefers-reduced-motion` support.
- No long-term conversation storage, telemetry, cloud proxy, or workbook snapshot upload. When the current workbook has a stable identifier, one active session is stored only in a DPAPI-encrypted cache for the current Windows user. The cache stays available while the task pane remains open through its periodic liveness heartbeat, even when no conversation is occurring, and is deleted 30 minutes after the last successful heartbeat (such as after the task pane or Excel closes or crashes), or on an explicit stop, reset, or clear.

## A Small Footer Detail

The task pane has a quiet footer easter egg: hover or focus the `ChatEx` mark to reveal a tiny baseline scene, then click it to keep the motion awake. The spatial idea is inspired by [Detail's footer easter egg](https://detail.design/zh/detail/footer-easter-egg), while the actual scene is drawn locally with CSS so the add-in has no extra network dependency. Reduced-motion users get the same control without continuous movement.

## Supported Protocols

The custom configuration page accepts an API root such as `https://api.openai.com`. ChatExcel adds the protocol version and method path automatically:

| Protocol | Generation endpoint | Model discovery | Streaming |
| --- | --- | --- | --- |
| OpenAI Responses | `/v1/responses` | `/v1/models` | SSE + JSON fallback |
| OpenAI Chat Completions | `/v1/chat/completions` | `/v1/models` | SSE + JSON fallback |
| Anthropic Messages | `/v1/messages` | `/v1/models` | SSE + JSON fallback |
| Google Gemini `generateContent` | `/v1beta/models/{model}:generateContent` | `/v1beta/models` | `:streamGenerateContent?alt=sse` + JSON fallback |

The adapter converts the shared internal tool loop, compatible client image inputs, tool calls, tool results, thinking settings, token usage, and provider-specific SSE events to and from each protocol. The task pane accepts text tasks only. Text deltas are forwarded immediately, while tool-call fragments are accumulated and validated only after the model step completes. A pasted `/v1`, `/v1beta`, or known method suffix is normalized automatically, and gateway path prefixes are preserved.

![ChatExcel custom provider settings](assets/screenshots/settings-400x900.png)

## Architecture

```text
Excel task pane (Office.js)
        │ same-origin HTTPS
        ▼
127.0.0.1:3210 local companion service
        │ protocol adapter + in-memory sessions
        ▼
Codex config, custom provider, or local gateway
```

- The task pane owns UI state, approval decisions, and Office.js execution.
- The local Node.js service reads configuration, protects credentials, discovers models, converts protocol messages, and enforces session limits.
- The provider receives the minimum task input, tool definitions, and tool results needed for the current loop.
- Conversation and workbook fragments remain in memory except for the current-workbook crash-recovery cache, which expires 30 minutes after the last successful task-pane liveness heartbeat.

## Technical Stack

- Microsoft Excel desktop and Office.js.
- Node.js 20+ (tested with Node.js 24), native ES modules, and Express 5.
- `smol-toml` for Codex `config.toml` parsing.
- Windows user-scoped DPAPI for custom API key encryption.
- Native Node test runner and the Microsoft Office add-in development toolchain.
- Local HTTPS using `office-addin-dev-certs`.
- .NET 8 self-contained Windows x64 launcher for the optional one-click distribution.

## Installation

Requirements:

- Windows 10/11.
- Microsoft Excel 2019 or Microsoft 365 desktop.
- Node.js 20 or newer.
- Either a usable `%CODEX_HOME%\\config.toml` / `%USERPROFILE%\\.codex\\config.toml`, or credentials for one of the supported custom protocols.

From the repository directory, the development workflow is:

```powershell
npm install
npm run icons
npm run certs:install
npm run certs:verify
npm run validate:manifest
npm run start:local
npm run sideload
```

The service is available at `https://localhost:3210`. `npm run start:local` starts a recovery monitor that manages only this project's service. If the managed Node.js process exits or stays unhealthy, the monitor retries with bounded backoff and waits for the existing HTTPS health check before considering it ready. The yellow load-error page is generated by the Excel host, so click `Retry` after recovery to reload the task pane. `npm run stop:local` stops both the service and its recovery monitor. The sideload script registers `manifest.xml`, locates the real Microsoft Excel executable through Windows App Paths, and opens a dedicated test workbook. In Excel, use the `ChatEx` group and click `Open ChatExcel`.

### One-click Windows launcher

To build the portable Windows x64 launcher:

```powershell
npm run build:launcher
```

The output is `dist/ChatExcel Launcher/`. Double-click `ChatExcel Launcher.exe`; it verifies or installs the Office development certificate, starts or reuses the local service with its recovery monitor, registers the add-in, and opens Microsoft Excel explicitly. If the managed service exits, the monitor restores it; once the Excel host load-error page is retried after recovery, the task pane reloads. The release folder includes its own Node.js runtime and the minimal service/Office sideload dependencies, so Node.js and .NET do not need to be installed on the target machine. Microsoft Excel desktop is still required.

### Existing workbooks

Dropping or opening a `.xlsx`, `.xlsm`, or `.xlsb` workbook through the launcher keeps the Office.js task-pane route. An existing `.xls` workbook uses the bundled native Excel companion pane instead: it opens the original absolute path, uses a per-session current-user pipe for tool execution, and never converts, saves, or creates an OOXML copy on its own. The `.xls` route requires desktop Microsoft Excel and the WebView2 Runtime; compatibility-mode limits are returned as explicit tool errors rather than silently changing the workbook format.

For the ready-to-run package, download `ChatExcel-Launcher-0.0.2-win-x64.zip` from the [GitHub Release](https://github.com/aEboli/ChatExcel/releases/tag/v0.0.2), extract it, and double-click the launcher. The adjacent `.sha256` file can be used to verify the download before extraction.

For a no-side-effect package check, run:

```powershell
npm run diagnose:launcher
```

The launcher writes only sanitized startup diagnostics to `%LOCALAPPDATA%\\ChatExcel\\launcher.log`. It never stores API keys, prompts, workbook data, tool results, or image attachments.

The source tree remains sufficient for development and local use; the launcher is an optional Windows distribution wrapper around the same service and sideload scripts.

## Configuration

### System Codex mode

ChatExcel reads the current user's Codex provider on each model step. A minimal Responses configuration looks like this:

```toml
model_provider = "local"
model = "your-model"
model_reasoning_effort = "high"
model_verbosity = "medium"

[model_providers.local]
name = "Local Provider"
base_url = "http://localhost:8080"
wire_api = "responses"
env_key = "LOCAL_MODEL_TOKEN"
```

`env_key` is preferred. `experimental_bearer_token` is supported for existing Codex configurations, but the token is never returned to the task pane.

### Custom provider mode

Turn off `Use system Codex configuration` in the settings page, choose a protocol, enter only the API root, fetch models, then choose a model ID, context length, reasoning level, and maximum step count. The maximum is validated server-side from 1 through 1000 and defaults to 100.

Custom settings are stored in `%APPDATA%\\ChatExcel\\settings.json`. Non-secret fields and the mode switch are stored as JSON; the API key is protected with the current Windows user's DPAPI before it is written. The plaintext key is kept only in the local service process while it is running.

## Usage Scenarios

- Inspect a selected range and summarize anomalies without leaving Excel.
- Turn selected report data into a structured worksheet.
- Fill formulas across a confirmed range, apply consistent number formats, and autofit columns.
- Create a native Excel table or chart from an existing range after reviewing the proposed action.
- Open an existing `.xls` workbook without converting it, then review and approve the same controlled operations in the native companion pane.
- Use a local Sub2API or another gateway through the protocol that it explicitly supports.
- Revisit an earlier activity row to inspect the conversation context without pretending to roll back the workbook.
- Draft long answers while they are still being generated, then stop the same task from the send control if the direction is wrong.

## Security and Privacy

- The service binds only to `127.0.0.1` and validates the request `Host` and `Origin`.
- The task pane never receives a plaintext or encrypted API key.
- Provider errors are summarized with credentials redacted; request bodies and workbook data are not logged.
- `store: false` and equivalent provider-side stateless message histories are used where the protocol supports them. The crash-recovery exception stores only one current-workbook session in a DPAPI-encrypted local cache and never automatically resends a model request or executes an Excel action.
- Excel mutations are limited to registered tools. Unknown tools and invalid arguments are not executed; correlated failures are returned to the agent for correction. Missing or duplicate call IDs, mismatched results, denied approval, cancellation, read-only workbooks, and the step limit remain enforced boundaries.
- ChatExcel does not bypass protection, macros, VBA, Power Query, or PivotTable security boundaries.

## Validation

```powershell
npm run check
npm test
npm run validate:manifest
npm audit --omit=dev
openspec validate --changes --strict --no-interactive
```

The current automated suite covers configuration parsing, DPAPI storage boundaries (with isolated test doubles), endpoint normalization, all four protocol adapters and their SSE accumulators, recoverable failed tool results, mixed valid/invalid calls, whole-row and whole-column ranges, compatible client image conversion, tool loops, session limits, HTTP origin checks, task-pane layout contracts, and add-in manifest validation. Browser acceptance was performed at 400x900 and 320x700, including the default-collapsed task group, group expansion, the single send/stop control, settings persistence, the compact idle state, auto-growing input, and no horizontal overflow. A real desktop-Excel long-running stream with a controllable fixture provider remains an external acceptance item.

## Limitations

- A desktop Excel installation and a trusted local development certificate are required for sideloading.
- The bundled launcher targets Windows x64 and Microsoft Excel desktop; it does not load the add-in into WPS. The native `.xls` companion route also requires WebView2.
- Provider model catalogs and reasoning capabilities vary; when metadata is absent, ChatExcel uses a conservative model-name mapping.
- The add-in does not create workbook snapshots or provide destructive workbook rollback. Historical activity is context-only and requires confirmation before continuing.
- Development dependencies include Microsoft's add-in tooling and should be kept updated independently of the local runtime dependencies.
- Desktop Excel stream cancellation still needs a dedicated controllable-provider smoke test; the protocol stream path itself is covered by automated tests and local task-pane preview checks.
- Native `.xls` changes must still be accepted against the target workbook in desktop Excel before relying on compatibility-mode table or chart behavior.
- Marketplace publication and multi-user cloud hosting are intentionally out of scope.

## License

No license has been selected yet. Add a license file before distributing ChatExcel outside the owning organization.
