using System;
using System.IO;

namespace ChatExcel.NativeAddIn
{
    internal static class NativeWebAssets
    {
        internal static string DirectoryPath
        {
            get
            {
                var directory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web");
                if (!File.Exists(Path.Combine(directory, "index.html")))
                {
                    throw new FileNotFoundException("ChatExcel 原生任务窗格资源不完整。", directory);
                }
                return directory;
            }
        }
    }
}
