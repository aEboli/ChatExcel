using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ChatExcel.NativeAddIn
{
    [ComVisible(true)]
    [Guid("487CEEAC-7E39-4F05-8F50-C1A468ACABFC")]
    [ProgId(ProgId)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public sealed class NativeTaskPaneControl : UserControl
    {
        public const string ProgId = "ChatExcel.NativeTaskPane";
        private const string VirtualHostName = "chatexcel.app";
        private readonly WebView2 webView = new() { Dock = DockStyle.Fill, Visible = false };
        private readonly Label status;
        private bool initializationStarted;

        public NativeTaskPaneControl()
        {
            BackColor = Color.FromArgb(28, 31, 38);
            ForeColor = Color.FromArgb(237, 241, 247);
            MinimumSize = new Size(280, 240);

            var layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                BackColor = BackColor,
                ColumnCount = 1,
                RowCount = 4,
                Padding = new Padding(20),
            };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            var title = new Label
            {
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold),
                ForeColor = ForeColor,
                Margin = new Padding(0, 0, 0, 12),
                Text = "ChatExcel",
            };

            status = new Label
            {
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(172, 184, 202),
                MaximumSize = new Size(340, 0),
                Text = "正在加载 ChatExcel 原生任务窗格。",
            };

            var footer = new Label
            {
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 8F),
                ForeColor = Color.FromArgb(119, 133, 153),
                Text = "该加载项不监听 HTTP 或 TCP 端口。",
            };

            layout.Controls.Add(title, 0, 0);
            layout.Controls.Add(status, 0, 1);
            layout.Controls.Add(footer, 0, 3);
            Controls.Add(layout);
            Controls.Add(webView);
            HandleCreated += (_, _) => BeginInitializeWebView();
        }

        private void BeginInitializeWebView()
        {
            if (initializationStarted || DesignMode || IsDisposed) return;
            initializationStarted = true;
            _ = InitializeWebViewAsync();
        }

        private async System.Threading.Tasks.Task InitializeWebViewAsync()
        {
            try
            {
                var userDataDirectory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ChatExcel",
                    "NativeAddIn",
                    "WebView2");
                Directory.CreateDirectory(userDataDirectory);
                var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataDirectory);
                await webView.EnsureCoreWebView2Async(environment);
                var core = webView.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.SetVirtualHostNameToFolderMapping(
                    VirtualHostName,
                    NativeWebAssets.DirectoryPath,
                    CoreWebView2HostResourceAccessKind.Deny);
                core.Navigate($"https://{VirtualHostName}/index.html");
                if (IsDisposed) return;
                status.Visible = false;
                webView.Visible = true;
                webView.BringToFront();
            }
            catch
            {
                if (!IsDisposed)
                {
                    status.Text = "无法加载原生任务窗格。请确认已安装 Microsoft Edge WebView2 Runtime。";
                }
            }
        }
    }
}
