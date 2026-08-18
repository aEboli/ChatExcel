using System;
using System.Reflection;
using System.Runtime.InteropServices;
using Extensibility;
using Office = Microsoft.Office.Core;

namespace ChatExcel.NativeAddIn
{
    [ComVisible(true)]
    [Guid("A7758431-BB7D-48E2-BE82-E4DC54E8541B")]
    [ProgId(ProgId)]
    [ClassInterface(ClassInterfaceType.None)]
    public sealed class ChatExcelAddIn : IDTExtensibility2, Office.IRibbonExtensibility, Office.ICustomTaskPaneConsumer
    {
        public const string ProgId = "ChatExcel.NativeAddIn";
        private const string WorkbookRibbonId = "Microsoft.Excel.Workbook";
        private const string TaskPaneTitle = "ChatExcel";

        private object application;
        private Office.ICTPFactory taskPaneFactory;
        private Office.CustomTaskPane taskPane;
        private Office.IRibbonUI ribbonUi;
        private bool disconnected;

        public void OnConnection(object application, ext_ConnectMode connectMode, object addInInst, ref Array custom)
        {
            this.application = application;
        }

        public void OnDisconnection(ext_DisconnectMode removeMode, ref Array custom)
        {
            disconnected = true;
            DisposeTaskPane();
            application = null;
            taskPaneFactory = null;
            ribbonUi = null;
        }

        public void OnAddInsUpdate(ref Array custom)
        {
        }

        public void OnStartupComplete(ref Array custom)
        {
        }

        public void OnBeginShutdown(ref Array custom)
        {
            disconnected = true;
            DisposeTaskPane();
        }

        public string GetCustomUI(string ribbonId)
        {
            return string.Equals(ribbonId, WorkbookRibbonId, StringComparison.Ordinal)
                ? RibbonXml.Value
                : null;
        }

        public void CTPFactoryAvailable(Office.ICTPFactory ctpFactoryInst)
        {
            taskPaneFactory = ctpFactoryInst;
        }

        public void OnRibbonLoad(Office.IRibbonUI ribbon)
        {
            ribbonUi = ribbon;
        }

        public void ToggleTaskPane(Office.IRibbonControl control, bool isPressed)
        {
            var pane = EnsureTaskPane();
            if (pane == null)
            {
                return;
            }

            pane.Visible = isPressed;
            InvalidateToggleButton();
        }

        public bool GetTaskPaneVisible(Office.IRibbonControl control)
        {
            return taskPane != null && taskPane.Visible;
        }

        private Office.CustomTaskPane EnsureTaskPane()
        {
            if (disconnected || taskPane != null || taskPaneFactory == null)
            {
                return taskPane;
            }

            var pane = taskPaneFactory.CreateCTP(NativeTaskPaneControl.ProgId, TaskPaneTitle, Missing.Value);
            pane.DockPosition = Office.MsoCTPDockPosition.msoCTPDockPositionRight;
            pane.Width = 390;
            ((Office._CustomTaskPaneEvents_Event)pane).VisibleStateChange += OnTaskPaneVisibleStateChange;
            taskPane = pane;
            return pane;
        }

        private void OnTaskPaneVisibleStateChange(Office.CustomTaskPane changedPane)
        {
            InvalidateToggleButton();
        }

        private void InvalidateToggleButton()
        {
            if (ribbonUi != null)
            {
                ribbonUi.InvalidateControl("ChatExcel.ToggleTaskPane");
            }
        }

        private void DisposeTaskPane()
        {
            var pane = taskPane;
            taskPane = null;
            if (pane == null)
            {
                return;
            }

            try
            {
                ((Office._CustomTaskPaneEvents_Event)pane).VisibleStateChange -= OnTaskPaneVisibleStateChange;
                pane.Delete();
            }
            catch (COMException)
            {
                // Excel can already have destroyed task panes during process shutdown.
            }
        }

        private static class RibbonXml
        {
            internal static readonly string Value =
                "<customUI xmlns=\"http://schemas.microsoft.com/office/2009/07/customui\" onLoad=\"OnRibbonLoad\">" +
                "<ribbon><tabs><tab id=\"ChatExcel.Tab\" label=\"ChatExcel\">" +
                "<group id=\"ChatExcel.Group\" label=\"ChatExcel\">" +
                "<toggleButton id=\"ChatExcel.ToggleTaskPane\" label=\"打开 ChatExcel\" " +
                "imageMso=\"HappyFace\" size=\"large\" onAction=\"ToggleTaskPane\" getPressed=\"GetTaskPaneVisible\" />" +
                "</group></tab></tabs></ribbon></customUI>";
        }
    }
}
