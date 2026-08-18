using System;
using Microsoft.Office.Tools;
using Office = Microsoft.Office.Core;

namespace ChatExcel.NativeVstoAddIn
{
    public partial class ThisAddIn
    {
        private const string TaskPaneTitle = "ChatExcel";
        private NativeTaskPaneControl taskPaneControl;
        private CustomTaskPane taskPane;
        private NativeRibbon ribbon;

        private void ThisAddIn_Startup(object sender, EventArgs e)
        {
            taskPaneControl = new NativeTaskPaneControl();
            taskPane = CustomTaskPanes.Add(taskPaneControl, TaskPaneTitle);
            taskPane.DockPosition = Office.MsoCTPDockPosition.msoCTPDockPositionRight;
            taskPane.Width = 390;
            taskPane.VisibleChanged += OnTaskPaneVisibleChanged;
            taskPane.Visible = false;
        }

        private void ThisAddIn_Shutdown(object sender, EventArgs e)
        {
            if (taskPane != null)
            {
                taskPane.VisibleChanged -= OnTaskPaneVisibleChanged;
            }

            taskPane = null;
            taskPaneControl = null;
            ribbon = null;
        }

        internal bool IsTaskPaneVisible => taskPane != null && taskPane.Visible;

        internal void SetTaskPaneVisible(bool visible)
        {
            if (taskPane == null)
            {
                return;
            }

            taskPane.Visible = visible;
            ribbon?.InvalidateTaskPaneToggle();
        }

        protected override Office.IRibbonExtensibility CreateRibbonExtensibilityObject()
        {
            return ribbon ?? (ribbon = new NativeRibbon(this));
        }

        private void OnTaskPaneVisibleChanged(object sender, EventArgs e)
        {
            ribbon?.InvalidateTaskPaneToggle();
        }

        private void InternalStartup()
        {
            Startup += ThisAddIn_Startup;
            Shutdown += ThisAddIn_Shutdown;
        }
    }
}
