using ChatExcelLauncher;
using System.Security.Cryptography;

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

        var sourcePath = Path.GetFullPath(args[0]);
        var sourceHash = ComputeHash(sourcePath);
        var temporaryDirectory = Path.Combine(Path.GetTempPath(), "ChatExcelNativeSmoke", Guid.NewGuid().ToString("N"));
        var temporaryWorkbook = Path.Combine(temporaryDirectory, Path.GetFileName(sourcePath));

        try
        {
            Directory.CreateDirectory(temporaryDirectory);
            File.Copy(sourcePath, temporaryWorkbook);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var result = LegacyWorkbookHost.RunSmokeTest(temporaryWorkbook);
            var sourceHashAfter = ComputeHash(sourcePath);
            if (!CryptographicOperations.FixedTimeEquals(sourceHash, sourceHashAfter))
            {
                Console.Error.WriteLine("Native smoke modified the source workbook.");
                return 1;
            }

            Console.WriteLine(result);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Native smoke failed: {error.Message}");
            return 1;
        }
        finally
        {
            try { Directory.Delete(temporaryDirectory, recursive: true); } catch { }
        }
    }

    private static byte[] ComputeHash(string path)
    {
        using var stream = File.OpenRead(path);
        return SHA256.HashData(stream);
    }
}
