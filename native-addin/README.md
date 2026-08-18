# ChatExcel Native Excel Add-in Probe

This directory contains the Windows x64 .NET Framework 4.8 native Excel add-in
probe. It implements `IDTExtensibility2`, `IRibbonExtensibility`, and
`ICustomTaskPaneConsumer`; Excel supplies the task-pane factory and the Ribbon
toggle creates a real right-docked `CustomTaskPane` from the COM-visible
`NativeTaskPaneControl` ProgID.

The task pane hosts WebView2 and maps the packaged `web/` directory to
`https://chatexcel.app/` with `SetVirtualHostNameToFolderMapping`. That virtual
host is internal to WebView2: it does not open an HTTP, HTTPS, or TCP listener,
and it does not access `localhost`.

## Build and Install

Run the current-user script from the repository root. It builds the x64 add-in,
copies only the required assembly, WebView2 files, and static resources into
`%LOCALAPPDATA%\ChatExcel\NativeAddIn\0.1.0`, then writes only ChatExcel-owned
HKCU COM and Excel Addins keys.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\native-addin.ps1 -Action build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\native-addin.ps1 -Action install
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\native-addin.ps1 -Action diagnose
```

Close every Excel process before installing or testing. Reopen 64-bit desktop
Excel, choose the `ChatExcel` tab, and click `打开 ChatExcel`. Use `-Action
uninstall` to remove only this native add-in's HKCU registrations; the existing
Office.js manifest and its optional `localhost:3210` service are intentionally
untouched.

## Prerequisites and Boundary

The probe requires 64-bit desktop Excel, .NET Framework 4.8, and Microsoft Edge
WebView2 Runtime. It is not a complete ChatExcel migration yet: the page is a
static proof that the native task pane and no-listener resource mapping work.
The later worker, named-pipe protocol, model configuration, streaming, and
current-workbook automation stages remain separately gated by real Excel
acceptance.
