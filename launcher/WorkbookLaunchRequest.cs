namespace ChatExcelLauncher;

internal enum WorkbookLaunchMode
{
    Default,
    Diagnose,
    Help,
    ServiceOnly,
    OfficeAddIn,
    NativeXls,
}

internal sealed record WorkbookLaunchRequest(WorkbookLaunchMode Mode, string? WorkbookPath = null)
{
    private static readonly HashSet<string> OfficeExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".xlsx",
        ".xlsm",
        ".xlsb",
    };

    public static WorkbookLaunchRequest Parse(IReadOnlyList<string> args)
    {
        if (args.Count == 0) return new WorkbookLaunchRequest(WorkbookLaunchMode.Default);
        if (args.Count != 1)
        {
            throw new LauncherInputException("一次只能打开一个工作簿。");
        }

        if (args[0] == "--diagnose") return new WorkbookLaunchRequest(WorkbookLaunchMode.Diagnose);
        if (args[0] == "--help") return new WorkbookLaunchRequest(WorkbookLaunchMode.Help);
        if (args[0] == "--service-only") return new WorkbookLaunchRequest(WorkbookLaunchMode.ServiceOnly);
        if (args[0].StartsWith("--", StringComparison.Ordinal))
        {
            throw new LauncherInputException("不支持该启动参数。");
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(args[0]);
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new LauncherInputException("工作簿路径无效。");
        }

        if (!File.Exists(fullPath))
        {
            throw new LauncherInputException("找不到要打开的工作簿。");
        }

        var extension = Path.GetExtension(fullPath);
        if (extension.Equals(".xls", StringComparison.OrdinalIgnoreCase))
        {
            return new WorkbookLaunchRequest(WorkbookLaunchMode.NativeXls, fullPath);
        }
        if (OfficeExtensions.Contains(extension))
        {
            return new WorkbookLaunchRequest(WorkbookLaunchMode.OfficeAddIn, fullPath);
        }

        throw new LauncherInputException("只支持 .xls、.xlsx、.xlsm 和 .xlsb 工作簿。");
    }
}

internal sealed class LauncherInputException(string message) : Exception(message);
