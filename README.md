# ChatExcel

<div align="center">

[![Version](https://img.shields.io/badge/version-v0.0.3-107c41.svg)](https://github.com/aEboli/ChatExcel/releases/tag/v0.0.3)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933.svg)](https://nodejs.org/)
[![Microsoft Excel](https://img.shields.io/badge/Microsoft-Excel-217346.svg)](https://www.microsoft.com/microsoft-365/excel)
[![Windows](https://img.shields.io/badge/Windows-x64-0078d4.svg)](https://github.com/aEboli/ChatExcel/releases)
[![中文说明](https://img.shields.io/badge/README-中文-1967a6.svg)](README.zh-CN.md)

**A local-first AI workbook agent for Microsoft Excel**

Inspect sheets, reason over workbook context, paste reference images, and perform controlled Excel edits from one compact task pane.

Latest packaged release: `v0.0.3` · current source snapshot: `v0.0.4` (not yet packaged as a GitHub Release)

</div>

> The Chinese README is the primary, more detailed guide: [README.zh-CN.md](README.zh-CN.md). This English page is a concise project overview.

## What's new in the v0.0.4 source snapshot

This source synchronization does not publish a new Windows launcher package. `v0.0.3` remains the latest downloadable GitHub Release.

- **Recoverable system configuration:** Settings can use Automatic (Codex CLI first), Codex CLI, or Claude CLI sources. Codex can load `OPENAI_API_KEY` from its sibling `auth.json`, while Claude uses the current user's Anthropic settings. Tokens remain in the local service.
- **Source setup launcher:** `首次安装并启动 ChatExcel.cmd` provides a Windows install, repair, and uninstall menu for a source checkout. It validates Node.js, dependencies, the development certificate, the manifest, and sideload readiness before opening Excel.
- **Task-pane recovery and image drop:** A failed system configuration keeps the custom API form available. PNG, JPEG, and WebP files can also be dropped into the composer, alongside the existing clipboard flow.
- **Safer sideload readiness:** The sideload script starts or reuses the project-local service before registering the add-in and opening Excel.

## What's new in v0.0.3

- **Clipboard image input:** paste PNG, JPEG, or WebP images into the composer, inspect fixed-size thumbnails, remove them, or open an accessible full preview before sending. Image-only tasks are supported.
- **Non-persistent image sessions:** attachments remain in page memory and use the existing multimodal provider adapters. Sessions containing images deliberately skip disk recovery so images never enter the encrypted recovery snapshot.
- **Capability-safe model controls:** exact official model matches use verified context and reasoning metadata; unknown OpenAI-compatible models default to automatic mode and expose compatibility choices separately from verified capability claims.
- **Protocol-specific reasoning:** ChatExcel preserves provider controls such as Qwen thinking toggles, DeepSeek V4 reasoning modes, and OpenAI reasoning levels without silently reusing an invalid selection after a model change.
- **Stricter workbook mutations:** range-changing tools enforce a `5,000`-cell impact boundary and report `impact` plus read-back `verification` data.
- **Compact task pane:** tighter fixed areas preserve more room for conversation and workbook results at 400px and 320px widths while retaining 12px/17px message text, 24px desktop hit targets, focus states, and reduced-motion behavior.

This release packages the verified `main` changes above for GitHub users and the Windows x64 launcher.

## What ChatExcel does

ChatExcel embeds a tool-using agent beside the active workbook. It can inspect ranges, write values and formulas, format cells, create tables or charts, and sort data through a narrow Excel tool surface. Read operations run automatically. Mutations either wait for explicit approval or run in the clearly selected no-approval mode.

| Area | Current behavior |
| --- | --- |
| Workbook tools | Read, values, formulas, formats, number formats, autofit, clear, worksheets, tables, charts, and sort |
| Agent loop | Streaming text, validated tool calls, structured tool errors, automatic correction, up to 1-1000 steps |
| Providers | System WorkBuddy configuration or a custom OpenAI Responses, Chat Completions, Anthropic Messages, or Gemini endpoint |
| Images | Up to 4 pasted PNG/JPEG/WebP attachments; thumbnails, delete, zoom, image-only send, protocol conversion |
| History | Collapsible task-level activity, read-only visual previews, guarded continuation from historical context |
| Recovery | One current-workbook session in a Windows-user DPAPI cache; image sessions are intentionally excluded |
| Distribution | Source development flow plus a self-contained Windows x64 launcher for desktop Excel |

## Interface

<p align="center">
  <img src="assets/screenshots/taskpane-compact-400x900.png" alt="ChatExcel compact task pane" width="390" />
  <img src="assets/screenshots/settings-400x900.png" alt="ChatExcel provider settings" width="390" />
</p>

The compact task pane keeps the workbook identity, conversation, grouped tool activity, model/reasoning controls, approval mode, and send/stop control visible without leaving Excel. It also includes a small local-only footer easter egg and respects `prefers-reduced-motion`.

## How it works

```text
Microsoft Excel task pane (Office.js)
              │ same-origin HTTPS
              ▼
  127.0.0.1:3210 local companion
              │ configuration + session loop + protocol adapter
              ▼
 WorkBuddy provider / custom API / local gateway
```

- Office.js or the native `.xls` companion executes registered workbook tools.
- The local Node.js service protects credentials, discovers models, converts the shared agent loop to the selected protocol, and streams events back to the task pane.
- Text, compatible image input, tool calls, tool results, reasoning blocks, and usage metadata are translated for each protocol.
- Complete tool arguments are validated before Excel is touched; unknown tools, invalid arguments, oversized ranges, missing approvals, and read-only workbooks fail closed.

## Supported protocols

Enter an API root such as `https://api.openai.com`; ChatExcel normalizes a pasted version or known method suffix while preserving gateway prefixes.

| Protocol | Generation endpoint | Discovery | Streaming |
| --- | --- | --- | --- |
| OpenAI Responses | `/v1/responses` | `/v1/models` | SSE + JSON fallback |
| OpenAI Chat Completions | `/v1/chat/completions` | `/v1/models` | SSE + JSON fallback |
| Anthropic Messages | `/v1/messages` | `/v1/models` | SSE + JSON fallback |
| Google Gemini | `/v1beta/models/{model}:generateContent` | `/v1beta/models` | `:streamGenerateContent?alt=sse` + JSON fallback |

Provider catalogs and compatible gateways vary. Model discovery or a successful connection test does not guarantee that a provider accepts every reasoning value, image input, or tool workflow.

## Quick start

### Packaged Windows launcher

1. Download `ChatExcel-Launcher-0.0.3-win-x64.zip` from [GitHub Releases](https://github.com/aEboli/ChatExcel/releases/tag/v0.0.3).
2. Verify the adjacent `.sha256` file if needed, then extract the whole archive.
3. Run `ChatExcel Launcher.exe`.
4. In Excel, open the `ChatEx` ribbon group and choose `Open ChatExcel`.

The package includes its own Node.js runtime and launcher dependencies. The target computer still needs Windows 10/11 and Microsoft Excel 2019 or Microsoft 365 desktop. WPS is not supported. Existing `.xls` workbooks also require WebView2.

### Source development

For a Windows source checkout, double-click `首次安装并启动 ChatExcel.cmd` in the repository root. The numeric menu offers `1` to install or reinstall and sideload ChatExcel in Excel, `2` to unregister this project's add-in, stop its local service, and remove project dependencies, and `3` to exit. Close all Excel windows before uninstalling; the source files and local development certificate are kept.

```powershell
git clone https://github.com/aEboli/ChatExcel.git
cd ChatExcel
npm install
npm run icons
npm run certs:install
npm run certs:verify
npm run validate:manifest
npm run start:local
npm run sideload
```

The companion service listens only on `https://localhost:3210`. Stop the project-owned service and supervisor with `npm run stop:local`.

## Existing workbook formats

| Format | Execution route | Format handling |
| --- | --- | --- |
| `.xlsx`, `.xlsm`, `.xlsb` | Office.js task pane | Uses the already opened workbook |
| `.xls` | Bundled native Excel companion | Opens the original absolute path and does not silently convert or create an OOXML copy |

Compatibility-mode limitations are returned as explicit tool errors. ChatExcel does not bypass worksheet protection, macros, VBA, Power Query, or PivotTable security boundaries.

## Configuration

ChatExcel can reuse the current user's WorkBuddy provider on every model step:

```toml
model_provider = "local"
model = "your-model"
model_reasoning_effort = "high"

[model_providers.local]
name = "Local Provider"
base_url = "http://localhost:8080"
wire_api = "responses"
env_key = "LOCAL_MODEL_TOKEN"
```

Settings also offers Automatic (Codex CLI first), Codex CLI, and Claude CLI sources. Codex reads the user-level `.codex/config.toml` and its sibling `auth.json`; Claude reads Anthropic settings from `.claude/settings.json`. Tokens stay in the local service and never enter the Excel task pane.

For a custom provider, disable system WorkBuddy configuration in Settings, choose a protocol, enter the API root and key, discover models, then select context, reasoning, and the maximum step count. Non-secret settings are stored in `%APPDATA%\ChatExcel\settings.json`; the API key is encrypted with the current Windows user's DPAPI and plaintext is kept only in the local process.

## Privacy and safety boundaries

- The service binds to `127.0.0.1` and validates `Host` and `Origin`.
- API keys are never returned to the task pane; provider failures go through credential redaction.
- Request bodies, prompts, workbook data, tool results, and image attachments are not written to logs.
- One recoverable text session may be stored in `%LOCALAPPDATA%\ChatExcel\conversation-recovery.json`, encrypted for the current Windows user and scoped to a stable workbook identity. It expires 30 minutes after the last successful task-pane heartbeat or is cleared on stop, reset, or explicit clear.
- Pasted images remain page-memory-only. Once a session contains an image, ChatExcel clears or skips its disk checkpoint and reports that recovery is unavailable while keeping the in-memory session usable.
- ChatExcel does not create workbook snapshots or promise rollback. Historical previews are visual and read-only.

## Project structure

```text
ChatExcel/
|-- assets/                  # Icons, local UI assets, and screenshots
|-- docs/                    # Verification notes
|-- launcher/                # .NET Windows launcher
|-- native-addin/            # Experimental local native-host probes
|-- openspec/                # Current specifications and archived changes
|-- scripts/                 # Certificates, lifecycle, sideload, build, and package scripts
|-- src/server/              # Local HTTPS service, sessions, recovery, and protocol adapters
|-- src/shared/              # Shared Excel tool schemas and application metadata
|-- src/taskpane/            # Office task pane UI and Excel execution
|-- tests/                   # Node tests plus native Excel smoke project
|-- manifest.xml             # Office add-in manifest
|-- package-lock.json
`-- package.json
```

## Development and validation

```powershell
npm run check
npm test
npm run validate:manifest
npm audit --omit=dev
npm run check:launcher
dotnet build tests/native-smoke/ChatExcel.NativeSmoke.csproj --configuration Release
openspec validate --all --strict
git diff --check
```

`npm run build:launcher` creates the portable launcher directory. `npm run diagnose:launcher` performs a no-side-effect package inspection. A real desktop Excel acceptance pass is still required for host-specific behavior such as long streaming cancellation, live workbook edits, and native `.xls` compatibility.

## Limitations

- Desktop Microsoft Excel is required; the add-in is not packaged for WPS, Excel Online, or macOS.
- The current release is Windows x64 and uses a trusted local Office development certificate.
- Unknown provider models use conservative automatic reasoning behavior until verified metadata is available.
- Image attachments depend on the selected upstream model or gateway supporting compatible multimodal input.
- `native-addin/` contains experimental local probes only; it is not bundled in the Windows launcher or supported as a production migration path.
- Marketplace publication, multi-user cloud hosting, macros, VBA, Power Query, PivotTable automation, snapshots, and destructive rollback are outside the current scope.

## Release and license

- Latest packaged release: [ChatExcel v0.0.3](https://github.com/aEboli/ChatExcel/releases/tag/v0.0.3)
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Detailed Chinese guide: [README.zh-CN.md](README.zh-CN.md)
- No license has been selected. Add a license before distributing the project outside the owning organization.
