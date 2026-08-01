# Changelog

All notable changes to ChatExcel are documented here.

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
