using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace ChatExcelLauncher;

internal static class Program
{
    private const string AppName = "ChatExcel Launcher";
    private const uint MessageBoxError = 0x00000010;
    private const uint MessageBoxInformation = 0x00000040;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    private static readonly Regex SecretPattern = new(
        "(?ix)(authorization\\s*[:=]\\s*bearer\\s+|bearer\\s+|x-api-key\\s*[:=]\\s*|x-goog-api-key\\s*[:=]\\s*|api[_-]?key\\s*[:=]\\s*|token\\s*[:=]\\s*)[^\\s,;\\\"'}]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    [STAThread]
    public static int Main(string[] args)
    {
        LauncherLog? log = null;
        try
        {
            WorkbookLaunchRequest request;
            try
            {
                request = WorkbookLaunchRequest.Parse(args);
            }
            catch (LauncherInputException error)
            {
                throw new LauncherException(error.Message, "参数");
            }

            var appRoot = ResolveAppRoot();
            log = new LauncherLog(appRoot);
            log.Write($"启动器开始，模式={request.Mode}，应用目录={appRoot}");

            if (request.Mode == WorkbookLaunchMode.Help)
            {
                MessageBox(
                    IntPtr.Zero,
                    "双击启动 ChatExcel。\n\n把 .xls 拖到启动器：使用内置原生引擎。\n把 .xlsx、.xlsm 或 .xlsb 拖到启动器：使用 Office 加载项。\n\n--diagnose 只检查发行目录，不启动服务或 Excel。",
                    AppName,
                    MessageBoxInformation);
                return 0;
            }

            var nodePath = ResolveNode(appRoot);
            ValidateResources(appRoot);
            if (request.Mode == WorkbookLaunchMode.Diagnose)
            {
                Diagnose(appRoot, nodePath, log);
                log.Write("诊断通过");
                return 0;
            }

            EnsureCertificate(appRoot, nodePath, log);
            RunService(appRoot, nodePath, log);
            if (request.Mode == WorkbookLaunchMode.NativeXls)
            {
                RunNativeXls(request.WorkbookPath!, log);
                log.Write("ChatExcel 原生 XLS 窗格已关闭，Excel 工作簿保持由用户控制");
                return 0;
            }

            RunSideload(appRoot, nodePath, log, request.WorkbookPath);
            log.Write(request.Mode == WorkbookLaunchMode.OfficeAddIn
                ? "ChatExcel 服务已启动，现代工作簿已交给 Office 加载项"
                : "ChatExcel 服务和 Excel 侧载流程已启动");
            return 0;
        }
        catch (LauncherException error)
        {
            log?.Write($"失败：阶段={error.Stage}，消息={error.Message}，详情={error.Detail}");
            ShowFailure(error.Message, error.Stage, error.Detail);
            return 1;
        }
        catch (Exception error)
        {
            log?.Write($"未预期失败：{error.Message}");
            ShowFailure("启动器遇到未预期错误。", "启动器", error.Message);
            return 1;
        }
    }

    private static string ResolveAppRoot()
    {
        var explicitRoot = Environment.GetEnvironmentVariable("CHATEXCEL_APP_ROOT");
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(explicitRoot)) candidates.Add(explicitRoot);

        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var current = directory; current is not null; current = current.Parent)
        {
            candidates.Add(current.FullName);
            candidates.Add(Path.Combine(current.FullName, "app"));
        }

        foreach (var candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (File.Exists(Path.Combine(candidate, "manifest.xml")) &&
                File.Exists(Path.Combine(candidate, "scripts", "start.ps1")))
            {
                return Path.GetFullPath(candidate);
            }
        }

        throw new LauncherException(
            "找不到 ChatExcel 应用目录。请把启动器放在发行目录中，或重新运行打包脚本。",
            "应用目录");
    }

    private static string ResolveNode(string appRoot)
    {
        var candidates = new List<string>();
        var configured = Environment.GetEnvironmentVariable("CHATEXCEL_NODE");
        if (!string.IsNullOrWhiteSpace(configured)) candidates.Add(configured);
        candidates.Add(Path.Combine(appRoot, "runtime", "node.exe"));

        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            candidates.Add(Path.Combine(directory, "node.exe"));
        }

        var node = candidates.FirstOrDefault(File.Exists);
        if (node is null)
        {
            throw new LauncherException(
                "找不到 Node.js 运行时。请使用完整发行目录，或安装 Node.js 20 以上版本。",
                "Node.js");
        }
        return Path.GetFullPath(node);
    }

    private static void ValidateResources(string appRoot)
    {
        var requiredFiles = new[]
        {
            "manifest.xml",
            "scripts/start.ps1",
            "scripts/service-supervisor.ps1",
            "scripts/sideload.mjs",
            "scripts/verify-certs.mjs",
            "src/server/index.js",
            "src/taskpane/taskpane.html",
            "node_modules/express/package.json",
            "node_modules/office-addin-dev-settings/package.json",
            "node_modules/office-addin-manifest/package.json",
        };
        var missing = requiredFiles
            .Where(relative => !File.Exists(Path.Combine(appRoot, relative.Replace('/', Path.DirectorySeparatorChar))))
            .ToArray();
        if (missing.Length > 0)
        {
            throw new LauncherException(
                "发行目录缺少必要文件，请重新运行打包脚本。",
                "发行目录",
                string.Join(", ", missing));
        }
    }

    private static void Diagnose(string appRoot, string nodePath, LauncherLog log)
    {
        var version = RunProcess(nodePath, new[] { "--version" }, appRoot, null, TimeSpan.FromSeconds(15));
        if (version.ExitCode != 0)
        {
            throw new LauncherException("Node.js 运行时无法执行。", "诊断", version.Error);
        }

        var verify = RunNode(appRoot, nodePath, "scripts/verify-certs.mjs", Array.Empty<string>());
        if (verify.ExitCode != 0)
        {
            throw new LauncherException(
                "本地开发证书尚未通过验证；正常启动时会尝试安装证书。",
                "诊断",
                verify.Error);
        }
        log.Write($"Node={version.Output.Trim()}，证书=valid");
    }

    private static void RunNativeXls(string workbookPath, LauncherLog log)
    {
        var sessionId = LegacyProtocol.CreateSessionId();
        log.Write("已选择原生 XLS 引擎，正在打开专用 Excel 实例和 ChatEx 窗格");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var host = new LegacyWorkbookHost(workbookPath, sessionId);
        Application.Run(host);
        if (host.WebViewInitializationFailure is { } error)
        {
            throw new LauncherException(
                "无法启动 ChatExcel 原生窗格。请确认已安装 Microsoft Edge WebView2 Runtime。",
                "WebView2",
                error.Message);
        }
    }

    private static void EnsureCertificate(string appRoot, string nodePath, LauncherLog log)
    {
        var verify = RunNode(appRoot, nodePath, "scripts/verify-certs.mjs", Array.Empty<string>());
        if (verify.ExitCode == 0) return;

        var certificateCli = Path.Combine(appRoot, "node_modules", "office-addin-dev-certs", "cli.js");
        if (!File.Exists(certificateCli))
        {
            throw new LauncherException("本地开发证书尚未安装，且发行目录没有证书安装组件。", "证书", verify.Error);
        }

        log.Write("证书验证未通过，开始调用 Office 开发证书安装器");
        var install = RunProcess(nodePath, new[] { certificateCli, "install" }, appRoot, null, TimeSpan.FromMinutes(2));
        if (install.ExitCode != 0)
        {
            throw new LauncherException(
                "无法安装本地 HTTPS 开发证书。请在 Windows 提示中允许信任当前用户证书，或手动运行 npm run certs:install。",
                "证书",
                install.Error);
        }

        var finalVerify = RunNode(appRoot, nodePath, "scripts/verify-certs.mjs", Array.Empty<string>());
        if (finalVerify.ExitCode != 0)
        {
            throw new LauncherException("证书安装完成但验证仍未通过。", "证书", finalVerify.Error);
        }
        log.Write("本地 HTTPS 开发证书验证通过");
    }

    private static void RunService(string appRoot, string nodePath, LauncherLog log)
    {
        var result = RunPowerShell(appRoot, nodePath, Path.Combine(appRoot, "scripts", "start.ps1"));
        if (result.ExitCode != 0)
        {
            throw new LauncherException(
                "本地服务没有成功启动。请检查端口 3210、证书和 %LOCALAPPDATA%\\ChatExcel\\launcher.log。",
                "本地服务",
                result.Error);
        }
        log.Write("本地服务健康检查通过");
    }

    private static void RunSideload(string appRoot, string nodePath, LauncherLog log, string? workbookPath)
    {
        var arguments = string.IsNullOrWhiteSpace(workbookPath)
            ? Array.Empty<string>()
            : new[] { "--workbook", workbookPath };
        var result = RunNode(appRoot, nodePath, "scripts/sideload.mjs", arguments, TimeSpan.FromMinutes(2));
        if (result.ExitCode != 0)
        {
            throw new LauncherException(
                "Excel 加载项没有成功侧载。请确认已安装 Microsoft Excel 桌面版，并检查 %LOCALAPPDATA%\\ChatExcel\\launcher.log。",
                "Excel 侧载",
                result.Error);
        }
        log.Write("Excel 侧载脚本已完成");
    }

    private static ProcessResult RunPowerShell(string appRoot, string nodePath, string scriptPath)
    {
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powershell)) powershell = "powershell.exe";
        var arguments = new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath };
        // start.ps1 launches a long-lived recovery supervisor. Do not capture the
        // PowerShell streams here: its service child can inherit those handles and
        // keep ReadToEndAsync waiting after PowerShell itself has exited.
        return RunProcess(powershell, arguments, appRoot, Path.GetDirectoryName(nodePath), TimeSpan.FromMinutes(2), captureOutput: false);
    }

    private static ProcessResult RunNode(string appRoot, string nodePath, string scriptPath, IReadOnlyList<string> extraArguments, TimeSpan? timeout = null)
    {
        var arguments = new List<string> { scriptPath };
        arguments.AddRange(extraArguments);
        return RunProcess(nodePath, arguments, appRoot, Path.GetDirectoryName(nodePath), timeout ?? TimeSpan.FromMinutes(2));
    }

    private static ProcessResult RunProcess(
        string fileName,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        string? nodeDirectory,
        TimeSpan timeout,
        bool captureOutput = true)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = captureOutput,
            RedirectStandardError = captureOutput,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        if (!string.IsNullOrWhiteSpace(nodeDirectory))
        {
            var currentPath = startInfo.Environment["PATH"] ?? Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            startInfo.Environment["PATH"] = nodeDirectory + Path.PathSeparator + currentPath;
        }

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start()) throw new InvalidOperationException("无法启动子进程。");
            if (!captureOutput)
            {
                if (!process.WaitForExit((int)timeout.TotalMilliseconds))
                {
                    try { process.Kill(entireProcessTree: true); } catch { }
                    throw new LauncherException("子进程超时，已停止等待。", "子进程", fileName);
                }
                return new ProcessResult(process.ExitCode, string.Empty, string.Empty);
            }

            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit((int)timeout.TotalMilliseconds))
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                throw new LauncherException("子进程超时，已停止等待。", "子进程", fileName);
            }
            Task.WaitAll(stdout, stderr);
            return new ProcessResult(process.ExitCode, SafeText(stdout.Result), SafeText(stderr.Result));
        }
        catch (LauncherException)
        {
            throw;
        }
        catch (Exception error)
        {
            throw new LauncherException("无法启动必要的本地子进程。", "子进程", error.Message);
        }
    }

    private static string SafeText(string? value)
    {
        var text = SecretPattern.Replace(value ?? string.Empty, "[REDACTED]");
        text = Regex.Replace(text, @"(?i)(https?://[^\s?]+)\?[^\s]+", "$1");
        return text.Replace('\r', ' ').Replace('\n', ' ').Trim();
    }

    private static void ShowFailure(string message, string stage, string? detail)
    {
        var suffix = string.IsNullOrWhiteSpace(detail) ? string.Empty : $"\n\n阶段：{stage}\n{SafeText(detail)}";
        MessageBox(IntPtr.Zero, message + suffix, AppName, MessageBoxError);
    }

    private sealed record ProcessResult(int ExitCode, string Output, string Error);

    private sealed class LauncherException(string message, string stage, string? detail = null) : Exception(message)
    {
        public string Stage { get; } = stage;
        public string? Detail { get; } = detail;
    }

    private sealed class LauncherLog
    {
        private readonly string path;

        public LauncherLog(string appRoot)
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ChatExcel");
            Directory.CreateDirectory(directory);
            path = Path.Combine(directory, "launcher.log");
            Write($"应用目录：{appRoot}");
        }

        public void Write(string message)
        {
            try
            {
                File.AppendAllText(path, $"{DateTimeOffset.Now:O} {SafeText(message)}{Environment.NewLine}", Encoding.UTF8);
            }
            catch
            {
                // Logging must never prevent the launcher from completing.
            }
        }
    }
}
