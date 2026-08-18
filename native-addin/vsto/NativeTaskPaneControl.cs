using System.Drawing;
using System.Windows.Forms;

namespace ChatExcel.NativeVstoAddIn
{
    internal sealed class NativeTaskPaneControl : UserControl
    {
        internal NativeTaskPaneControl()
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

            layout.Controls.Add(new Label
            {
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold),
                ForeColor = ForeColor,
                Margin = new Padding(0, 0, 0, 12),
                Text = "ChatExcel",
            }, 0, 0);

            layout.Controls.Add(new Label
            {
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(172, 184, 202),
                MaximumSize = new Size(340, 0),
                Text = "原生 Excel 任务窗格已就绪。",
            }, 0, 1);

            layout.Controls.Add(new Label
            {
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 8F),
                ForeColor = Color.FromArgb(119, 133, 153),
                Text = "此探针由 Excel 直接打开，不监听 HTTP 或 TCP 端口。",
            }, 0, 3);

            Controls.Add(layout);
        }
    }
}
