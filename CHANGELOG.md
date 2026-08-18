# Changelog

All notable changes to ChatExcel are documented here.

## [0.0.4] - 2026-08-18

> Source synchronization only. No `v0.0.4` GitHub Release or Windows launcher package is published with this entry; `v0.0.3` remains the latest packaged release.

### Added

- Selectable system CLI configuration sources: Automatic (Codex CLI first), Codex CLI, and Claude CLI. Codex can recover `OPENAI_API_KEY` from its sibling `auth.json`; Claude reads the current user's Anthropic settings. Tokens remain inside the local Node.js service.
- A double-click Windows source-checkout launcher, `首次安装并启动 ChatExcel.cmd`, with install, repair, and uninstall flows that validate Node.js, dependencies, the development certificate, the manifest, and sideload readiness.
- PNG, JPEG, and WebP image drag-and-drop support in the task-pane composer, alongside the existing clipboard attachment flow.

### Changed

- System-configuration failures now keep the custom API form available, and the selected CLI source is persisted with rollback on a failed source switch.
- Codex configuration accepts the `ultra` reasoning level; verified DeepSeek V4 metadata can show the maximum output capability in Settings.
- Sideloading starts or reuses the project-local service before registering the add-in and opening Excel. Certificate verification remains compatible with the declared Node.js 20 baseline.

### Known limitations

- `native-addin/` contains experimental local probes. They are not bundled into the Windows launcher and require real Excel acceptance plus controlled signing before any distribution decision.
- Desktop Excel acceptance is still required for long-running stream cancellation, live workbook edits, and native `.xls` compatibility.

## [0.0.3] - 2026-08-07

### Added

- Clipboard PNG, JPEG, and WebP image input with image-only tasks, fixed-size thumbnails, accessible preview controls, and protocol-level multimodal conversion. Image attachments remain page-memory-only and are excluded from recovery checkpoints.
- Capability-safe model and reasoning controls: verified official metadata remains separate from compatible fallbacks, while unknown OpenAI-compatible models default to automatic reasoning.
- A `5,000`-cell impact boundary for range-changing tools, with `impact` and read-back `verification` summaries after successful mutations.

### Changed

- Tightened the task-pane layout at 400px and 320px widths so fixed controls leave more room for conversation and workbook results. Message text remains 12px/17px, common desktop controls retain at least 24px hit targets, and focus and reduced-motion behavior are unchanged.
- Updated the Windows x64 launcher, ZIP naming, README download links, and release metadata to `0.0.3`.

### Known limitations

- The native `.xls` companion route still requires desktop Microsoft Excel and WebView2. Compatibility-mode table and chart behavior must be accepted against the target workbook before operational use.
- Desktop Excel long-running stream cancellation, live workbook edits, and native `.xls` compatibility still require host-level acceptance on the target machine.

## [0.0.2] - 2026-08-02

### Added

- A native companion route for existing `.xls` workbooks. The Windows launcher opens the original legacy path, keeps the file format under Excel's control, and uses a one-time current-user pipe for approved tool execution.
- A DPAPI-encrypted, current-workbook crash-recovery cache with a 30-minute task-pane liveness lease. Recovery never automatically resends a model request or replays an Excel operation.
- A bounded local-service recovery monitor that restarts only the managed ChatExcel service after an unhealthy exit.
- Read-only visual previews for operation-history steps, with bounded range/chart captures and a grid fallback that does not save or mutate the workbook.

### Changed

- Correlated model tool failures can return structured errors to Responses, Chat Completions, Anthropic Messages, and Gemini so the agent can repair invalid tool names, arguments, and ranges without touching the workbook first.
- A1 range handling now recognizes whole-row and whole-column addresses; the compact task pane accepts text tasks only.
- Launcher packaging derives its release asset version from npm metadata and now produces `ChatExcel-Launcher-0.0.2-win-x64.zip` with a matching SHA-256 file.

### Known limitations

- The native `.xls` companion route requires desktop Microsoft Excel and WebView2. Compatibility-mode table and chart behavior must be accepted against the target workbook before operational use.
- Desktop Excel long-running stream cancellation still needs a dedicated controllable-provider acceptance test.

## [0.0.1] - 2026-08-01

The first GitHub release of the local Excel agent.

### Added

- Windows x64 `ChatExcel Launcher.exe` that checks the Office development certificate, starts or reuses the local HTTPS service, registers the add-in, and opens Microsoft Excel.
- Local-first provider configuration that can reuse the current user's Codex setup or protect a custom API key with Windows DPAPI.
- OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and Google Gemini protocol adapters with SSE streaming and JSON fallback.
- Workbook-aware Excel tools with approval and no-approval modes, grouped activity history, historical context guards, image attachments, clipboard image paste, and configurable step limits.
- CSS-only footer easter egg inspired by [Detail's footer easter egg](https://detail.design/zh/detail/footer-easter-egg). It stays quiet by default, wakes on hover/focus, and respects reduced-motion preferences.
- English and Simplified Chinese documentation, architecture notes, release packaging, diagnostics, and validation commands.

### Security and boundaries

- The companion service binds only to loopback HTTPS and validates `Host` and `Origin`.
- API keys, workbook data, prompts, tool results, and images are not written to the repository or launcher logs.
- The launcher targets Microsoft Excel desktop on Windows x64. WPS is not a supported sideload host.

### Known limitations

- A trusted Office development certificate and desktop Microsoft Excel are required for sideloading.
- Desktop Excel long-running stream cancellation still needs a dedicated controllable-provider acceptance test; the protocol stream path and task-pane preview are covered by automated tests.
- No license has been selected yet. Add a license before distributing ChatExcel outside the owning organization.

[0.0.1]: https://github.com/aEboli/ChatExcel/releases/tag/v0.0.1
[0.0.2]: https://github.com/aEboli/ChatExcel/releases/tag/v0.0.2
[0.0.3]: https://github.com/aEboli/ChatExcel/releases/tag/v0.0.3
