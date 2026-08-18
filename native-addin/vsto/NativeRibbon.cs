using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Office = Microsoft.Office.Core;

namespace ChatExcel.NativeVstoAddIn
{
    [ComVisible(true)]
    public sealed class NativeRibbon : Office.IRibbonExtensibility
    {
        private const string TaskPaneToggleId = "ChatExcel.NativeVsto.ToggleTaskPane";
        private readonly ThisAddIn addIn;
        private Office.IRibbonUI ribbonUi;

        public NativeRibbon(ThisAddIn addIn)
        {
            this.addIn = addIn ?? throw new ArgumentNullException(nameof(addIn));
        }

        public string GetCustomUI(string ribbonId)
        {
            return string.Equals(ribbonId, "Microsoft.Excel.Workbook", StringComparison.Ordinal)
                ? ReadEmbeddedResource("ChatExcel.NativeVstoAddIn.NativeRibbon.xml")
                : null;
        }

        public void Ribbon_Load(Office.IRibbonUI ribbon)
        {
            ribbonUi = ribbon;
        }

        public void ToggleTaskPane(Office.IRibbonControl control, bool isPressed)
        {
            addIn.SetTaskPaneVisible(isPressed);
        }

        public bool GetTaskPaneVisible(Office.IRibbonControl control)
        {
            return addIn.IsTaskPaneVisible;
        }

        internal void InvalidateTaskPaneToggle()
        {
            ribbonUi?.InvalidateControl(TaskPaneToggleId);
        }

        private static string ReadEmbeddedResource(string resourceName)
        {
            var assembly = Assembly.GetExecutingAssembly();
            using (var stream = assembly.GetManifestResourceStream(resourceName))
            using (var reader = stream == null ? null : new StreamReader(stream))
            {
                return reader?.ReadToEnd();
            }
        }
    }
}
