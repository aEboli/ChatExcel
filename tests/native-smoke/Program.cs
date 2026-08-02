using ChatExcelLauncher;

namespace ChatExcelNativeSmoke;

internal static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length != 1 || !File.Exists(args[0]))
        {
            Console.Error.WriteLine("Usage: ChatExcel.NativeSmoke <existing.xls>");
            return 2;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Console.WriteLine(LegacyWorkbookHost.RunSmokeTest(Path.GetFullPath(args[0])));
        return 0;
    }
}
