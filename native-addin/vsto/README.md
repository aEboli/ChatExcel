# ChatExcel Native VSTO Probe

This directory contains the supported first-stage native Excel host: an x64
.NET Framework 4.8 VSTO Add-in. It creates a true Excel `CustomTaskPane` from
`ThisAddIn` and exposes a Ribbon toggle. It intentionally has no `localhost`,
HTTP, TCP, Node, or WebView2 dependency.

Build it with the x64 MSBuild installed by Visual Studio:

```powershell
& 'C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\amd64\MSBuild.exe' `
  .\native-addin\vsto\ChatExcel.NativeVstoAddIn.csproj `
  /t:Rebuild /p:Configuration=Release /p:Platform=x64 /v:minimal
```

Use `scripts/native-vsto-addin.ps1` for the current-user build, install,
diagnose, and uninstall paths. The project creates signed VSTO deployment
manifests and the script installs them through VSTOInstaller; it does not
register raw COM CLSID values or load a bare DLL into Excel.

The included certificate is a development certificate for this local probe.
The installer trusts only its public certificate under the current user's
TrustedPublisher store. A release must replace it with a controlled signing
certificate before distribution.

The previous low-level COM probe in the parent directory remains separate and
is not used by this VSTO project.
