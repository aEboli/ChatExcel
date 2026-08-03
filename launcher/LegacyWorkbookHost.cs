using System.Drawing;
using Microsoft.CSharp.RuntimeBinder;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ChatExcelLauncher;

internal sealed class LegacyWorkbookHost : Form
{
    private const int MacroSecurityForceDisable = 3;
    private const int PaneWidth = 420;
    private const int XlReferenceStyleA1 = 1;
    private const int XlHAlignGeneral = 1;
    private const int XlHAlignLeft = -4131;
    private const int XlHAlignCenter = -4108;
    private const int XlHAlignRight = -4152;
    private const int XlVAlignTop = -4160;
    private const int XlVAlignCenter = -4108;
    private const int XlVAlignBottom = -4107;
    private const int XlColumnClustered = 51;
    private const int XlBarClustered = 57;
    private const int XlLine = 4;
    private const int XlPie = 5;
    private const int XlDoughnut = -4120;
    private const int XlArea = 1;
    private const int XlXYScatter = -4169;
    private const int XlRows = 1;
    private const int XlColumns = 2;
    private const int XlSrcRange = 1;
    private const int XlYes = 1;
    private const int XlNo = 2;
    private const int XlAscending = 1;
    private const int XlDescending = 2;
    private const int XlSortRows = 2;
    private const int MaxMutationCells = 5_000;
    private const int MaxNumberFormatCells = MaxMutationCells;
    private const int MaxAutofitDimensions = 5_000;
    private const int SheetActivateDispId = 0x619;
    private const int SheetChangeDispId = 0x61c;
    private const int WorkbookBeforeCloseDispId = 0x622;
    private static readonly Guid AppEventsIid = new("00024413-0000-0000-C000-000000000046");
    private static readonly HashSet<string> FormulaErrorValues = new(StringComparer.OrdinalIgnoreCase)
    {
        "#BLOCKED!",
        "#BUSY!",
        "#CALC!",
        "#CONNECT!",
        "#DIV/0!",
        "#FIELD!",
        "#GETTING_DATA",
        "#N/A",
        "#NAME?",
        "#NULL!",
        "#NUM!",
        "#REF!",
        "#SPILL!",
        "#UNKNOWN!",
        "#VALUE!",
    };
    private static readonly HashSet<ushort> FormulaErrorCodes = new()
    {
        2000,
        2007,
        2015,
        2023,
        2029,
        2036,
        2042,
        2043,
    };
    private readonly string sessionId;
    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer windowTimer = new() { Interval = 400 };
    private readonly LegacyPipeServer pipeServer;
    private dynamic? excel;
    private dynamic? workbook;
    private SheetChangeEventHandler? sheetChangeHandler;
    private SheetActivateEventHandler? sheetActivateHandler;
    private WorkbookBeforeCloseEventHandler? workbookBeforeCloseHandler;
    private bool suppressEvents;
    private bool workbookClosed;
    private bool workbookClosePending;
    private int revision;
    private int activeSheetRevision;
    private IntPtr excelWindow;
    private bool released;
    private Exception? webViewInitializationFailure;

    internal Exception? WebViewInitializationFailure => webViewInitializationFailure;

    public LegacyWorkbookHost(string workbookPath, string sessionId)
    {
        this.sessionId = sessionId;
        Text = "ChatExcel - XLS";
        FormBorderStyle = FormBorderStyle.SizableToolWindow;
        MinimumSize = new Size(340, 520);
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Controls.Add(webView);

        OpenWorkbook(workbookPath);
        pipeServer = new LegacyPipeServer(sessionId, HandlePipeRequest);
        pipeServer.Start();
        windowTimer.Tick += (_, _) => TrackExcelWindow();
        windowTimer.Start();
        Shown += async (_, _) => await InitializeWebViewAsync();
        FormClosed += (_, _) => ReleaseHost();
    }

    protected override void OnLoad(EventArgs eventArgs)
    {
        base.OnLoad(eventArgs);
        if (excelWindow != IntPtr.Zero) new WindowOwner(excelWindow).AssignTo(this);
        TrackExcelWindow();
    }

    private void OpenWorkbook(string workbookPath)
    {
        var createdExcel = false;
        try
        {
            var excelType = Type.GetTypeFromProgID("Excel.Application", throwOnError: true)!;
            excel = Activator.CreateInstance(excelType)
                ?? throw new InvalidOperationException("无法创建 Excel.Application COM 实例。");
            createdExcel = true;
            excel.AskToUpdateLinks = false;
            excel.DisplayAlerts = true;
            excel.Visible = false;
            excel.AutomationSecurity = MacroSecurityForceDisable;
            dynamic workbooks = excel.Workbooks;
            try
            {
                workbook = workbooks.Open(
                    workbookPath,
                    0,
                    false,
                    Type.Missing,
                    Type.Missing,
                    Type.Missing,
                    true,
                    Type.Missing,
                    Type.Missing,
                    Type.Missing,
                    false,
                    Type.Missing,
                    true);
            }
            finally
            {
                ReleaseCom((object?)workbooks);
            }
            excel.Visible = true;
            excelWindow = new IntPtr(excel.Hwnd);
            sheetChangeHandler = OnSheetChange;
            sheetActivateHandler = OnSheetActivate;
            workbookBeforeCloseHandler = OnWorkbookBeforeClose;
            ComEventsHelper.Combine(excel, AppEventsIid, SheetChangeDispId, sheetChangeHandler);
            ComEventsHelper.Combine(excel, AppEventsIid, SheetActivateDispId, sheetActivateHandler);
            ComEventsHelper.Combine(excel, AppEventsIid, WorkbookBeforeCloseDispId, workbookBeforeCloseHandler);
        }
        catch (Exception error) when (error is COMException or TypeLoadException or InvalidOperationException or RuntimeBinderException)
        {
            QuitOwnedExcelAfterOpenFailure(createdExcel);
            ReleaseExcelReferences();
            throw new LauncherInputException($"无法用 Microsoft Excel 打开该 .xls 工作簿：{SafeComMessage(error)}");
        }
        catch
        {
            QuitOwnedExcelAfterOpenFailure(createdExcel);
            ReleaseExcelReferences();
            throw;
        }
    }

    private void QuitOwnedExcelAfterOpenFailure(bool createdExcel)
    {
        if (!createdExcel || excel is null) return;
        try { excel.DisplayAlerts = false; } catch { }
        try { excel.Quit(); } catch { }
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var dataDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ChatExcel",
                "WebView2");
            Directory.CreateDirectory(dataDirectory);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataDirectory);
            var controllerOptions = environment.CreateCoreWebView2ControllerOptions();
            controllerOptions.IsInPrivateModeEnabled = true;
            await webView.EnsureCoreWebView2Async(environment, controllerOptions);
            webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Navigate($"https://localhost:3210/taskpane.html?legacy={sessionId}");
        }
        catch (Exception error)
        {
            if (IsDisposed || Disposing) return;
            webViewInitializationFailure = error;
            if (!IsDisposed) Close();
        }
    }

    private object HandlePipeRequest(JsonElement request)
    {
        if (InvokeRequired) return Invoke(() => HandlePipeRequest(request));
        if (workbookClosed || excel is null || workbook is null)
        {
            throw new LegacyWorkbookException("WORKBOOK_CLOSED", "原生 .xls 工作簿已关闭。");
        }
        if (request.ValueKind != JsonValueKind.Object ||
            !request.TryGetProperty("action", out var actionElement) ||
            actionElement.ValueKind != JsonValueKind.String)
        {
            throw new LegacyWorkbookException("NATIVE_REQUEST_INVALID", "原生桥请求缺少有效操作。");
        }

        return actionElement.GetString() switch
        {
            "state" => GetState(),
            "undo" => Undo(),
            "execute" => ExecuteToolRequest(request),
            _ => throw new LegacyWorkbookException("NATIVE_ACTION_UNKNOWN", "原生桥操作不受支持。"),
        };
    }

    private object GetState()
    {
        var worksheet = GetActiveWorksheet();
        try
        {
            var workbookName = Path.GetFileNameWithoutExtension(workbook!.Name);
            return new
            {
                ok = true,
                engine = "native-xls",
                workbook = workbookName,
                worksheet = worksheet.Name,
                label = $"{workbookName}-{worksheet.Name}",
                readOnly = workbook.ReadOnly,
                revision,
                activeSheetRevision,
                closed = false,
            };
        }
        finally
        {
            ReleaseCom((object?)worksheet);
        }
    }

    private object Undo()
    {
        dynamic? activeWorkbook = null;
        try
        {
            activeWorkbook = excel!.ActiveWorkbook;
            if (!IsSameComObject(activeWorkbook, (object)workbook!))
            {
                throw new LegacyWorkbookException("UNDO_UNAVAILABLE", "请先激活 ChatExcel 绑定的 .xls 工作簿，再执行撤销。");
            }
            suppressEvents = true;
            excel!.Undo();
            revision += 1;
            return new { ok = true, revision };
        }
        catch (COMException error)
        {
            throw new LegacyWorkbookException("UNDO_UNAVAILABLE", $"Excel 无法撤销最近修改：{SafeComMessage(error)}");
        }
        finally
        {
            suppressEvents = false;
            // The active workbook can be a separately open user workbook. Do not
            // release its RCW while that caller may still need it after rejection.
        }
    }

    private object ExecuteToolRequest(JsonElement request)
    {
        if (!request.TryGetProperty("name", out var nameElement) || nameElement.ValueKind != JsonValueKind.String ||
            !request.TryGetProperty("arguments", out var arguments) || arguments.ValueKind != JsonValueKind.Object)
        {
            throw new LegacyWorkbookException("NATIVE_REQUEST_INVALID", "原生工具请求缺少名称或参数。");
        }
        var name = nameElement.GetString()!;
        var modification = name is not ("get_workbook_info" or "get_selection" or "read_range");
        if (modification && workbook!.ReadOnly)
        {
            throw new LegacyWorkbookException("WORKBOOK_READ_ONLY", "当前 .xls 工作簿为只读，不能执行修改。");
        }

        try
        {
            suppressEvents = true;
            var result = ExecuteTool(name, arguments);
            if (modification) revision += 1;
            return result;
        }
        catch (LegacyWorkbookException)
        {
            throw;
        }
        catch (COMException error)
        {
            throw new LegacyWorkbookException("NATIVE_EXCEL_ERROR", SafeComMessage(error));
        }
        finally
        {
            suppressEvents = false;
        }
    }

    private object ExecuteTool(string name, JsonElement arguments) => name switch
    {
        "get_workbook_info" => GetWorkbookInfo(),
        "get_selection" => GetSelection(),
        "read_range" => ReadRange(arguments),
        "write_values" => WriteMatrix(arguments, "values", formulas: false),
        "write_formulas" => WriteMatrix(arguments, "formulas", formulas: true),
        "format_range" => FormatRange(arguments),
        "set_number_format" => SetNumberFormat(arguments),
        "autofit_range" => AutofitRange(arguments),
        "clear_range" => ClearRange(arguments),
        "add_worksheet" => AddWorksheet(arguments),
        "rename_worksheet" => RenameWorksheet(arguments),
        "create_table" => CreateTable(arguments),
        "create_chart" => CreateChart(arguments),
        "sort_range" => SortRange(arguments),
        _ => throw new LegacyWorkbookException("TOOL_NOT_IMPLEMENTED", $"Excel 原生工具尚未实现：{name}"),
    };

    private object GetWorkbookInfo()
    {
        var names = new List<string>();
        dynamic worksheets = workbook!.Worksheets;
        dynamic? active = null;
        dynamic? selection = null;
        try
        {
            for (var index = 1; index <= worksheets.Count; index += 1)
            {
                dynamic worksheet = worksheets[index];
                try { names.Add(worksheet.Name); } finally { ReleaseCom((object?)worksheet); }
            }
            active = GetActiveWorksheet();
            selection = GetSelectedRange(out var selectionIsRange);
            return new
            {
                ok = true,
                workbook = new
                {
                    worksheets = names,
                    activeWorksheet = active.Name,
                    selection = new
                    {
                        address = RangeAddress(selection),
                        rowCount = selection.Rows.Count,
                        columnCount = selection.Columns.Count,
                        mode = selectionIsRange ? "range" : "activeCell",
                    },
                },
            };
        }
        finally
        {
            ReleaseCom((object?)selection);
            ReleaseCom((object?)active);
            ReleaseCom((object?)worksheets);
        }
    }

    private object GetSelection()
    {
        var range = GetSelectedRange(out _);
        try { return ReadRangeObject(range); } finally { ReleaseCom((object?)range); }
    }

    private object ReadRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        try { return ReadRangeObject(range); } finally { ReleaseCom((object?)range); }
    }

    private object ReadRangeObject(dynamic range)
    {
        var rowCount = range.Rows.Count;
        var columnCount = range.Columns.Count;
        var cellCount = checked(rowCount * columnCount);
        if (cellCount > 2_000)
        {
            throw new LegacyWorkbookException("READ_RANGE_TOO_LARGE", $"目标范围包含 {cellCount} 个单元格，超过 2000 个读取限制。");
        }
        dynamic worksheet = range.Worksheet;
        try
        {
            return new
            {
                ok = true,
                target = $"{worksheet.Name}!{RangeAddress(range)}",
                worksheet = worksheet.Name,
                rowCount,
                columnCount,
                cellCount,
                values = ToRows(range.Value2, rowCount, columnCount),
                formulas = ToRows(range.Formula, rowCount, columnCount),
                numberFormat = ReadNumberFormatRows(range, rowCount, columnCount),
            };
        }
        finally
        {
            ReleaseCom((object?)worksheet);
        }
    }

    private object WriteMatrix(JsonElement arguments, string property, bool formulas)
    {
        var range = GetRange(arguments);
        try
        {
            var inspection = InspectMutationRange(range);
            var matrix = RequiredMatrix(arguments, property);
            var rowCount = inspection.RowCount;
            var columnCount = inspection.ColumnCount;
            if (matrix.GetLength(0) != rowCount || matrix.GetLength(1) != columnCount)
            {
                throw new LegacyWorkbookException("MATRIX_SIZE_MISMATCH", $"二维数组尺寸与目标范围不一致；目标为 {rowCount} 行 x {columnCount} 列。");
            }
            if (formulas)
            {
                range.Formula = matrix;
                range.Calculate();
            }
            else
            {
                range.Value2 = matrix;
            }
            var contents = ReadRangeContents(range, rowCount, columnCount);
            var matches = MatrixMatches(formulas ? contents.Formulas : contents.Values, matrix, rowCount, columnCount);
            AssertVerification(matches, "WRITE_VERIFICATION_FAILED", "Excel 未能确认值或公式已按请求写入。");
            return RangeResult(
                range,
                new { rowCount, columnCount },
                inspection.Impact,
                new Dictionary<string, object?>
                {
                    ["kind"] = formulas ? "formulas" : "values",
                    ["matches"] = true,
                    ["formulaErrorCells"] = contents.FormulaErrorCells,
                });
        }
        finally
        {
            ReleaseCom((object?)range);
        }
    }

    private object FormatRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        dynamic? interior = null;
        dynamic? font = null;
        try
        {
            var inspection = InspectMutationRange(range);
            interior = range.Interior;
            font = range.Font;
            if (OptionalString(arguments, "fillColor") is { } fillColor) interior.Color = ColorTranslator.ToOle(ColorTranslator.FromHtml(fillColor));
            if (OptionalString(arguments, "fontColor") is { } fontColor) font.Color = ColorTranslator.ToOle(ColorTranslator.FromHtml(fontColor));
            if (OptionalBoolean(arguments, "bold") is { } bold) font.Bold = bold;
            if (OptionalBoolean(arguments, "italic") is { } italic) font.Italic = italic;
            if (OptionalDouble(arguments, "fontSize") is { } fontSize) font.Size = fontSize;
            if (OptionalString(arguments, "horizontalAlignment") is { } horizontal) range.HorizontalAlignment = HorizontalAlignment(horizontal);
            if (OptionalString(arguments, "verticalAlignment") is { } vertical) range.VerticalAlignment = VerticalAlignment(vertical);
            if (OptionalBoolean(arguments, "wrapText") is { } wrapText) range.WrapText = wrapText;
            return RangeResult(
                range,
                new { rowCount = inspection.RowCount, columnCount = inspection.ColumnCount },
                inspection.Impact,
                VerifyRangeFormat(range, arguments));
        }
        finally
        {
            ReleaseCom((object?)font);
            ReleaseCom((object?)interior);
            ReleaseCom((object?)range);
        }
    }

    private object SetNumberFormat(JsonElement arguments)
    {
        var range = GetRange(arguments);
        try
        {
            var inspection = InspectMutationRange(range, numberFormat: true);
            var formatCode = RequiredString(arguments, "formatCode");
            range.NumberFormat = formatCode;
            var numberFormats = ReadNumberFormatRows(range, inspection.RowCount, inspection.ColumnCount);
            var matches = NumberFormatsMatch(numberFormats, formatCode, inspection.RowCount, inspection.ColumnCount);
            AssertVerification(matches, "NUMBER_FORMAT_VERIFICATION_FAILED", "Excel 未能确认数字格式已按请求应用。");
            var contents = ReadRangeContents(range, inspection.RowCount, inspection.ColumnCount);
            return RangeResult(
                range,
                new { rowCount = inspection.RowCount, columnCount = inspection.ColumnCount },
                inspection.Impact,
                new Dictionary<string, object?>
                {
                    ["kind"] = "numberFormat",
                    ["matches"] = true,
                    ["formatCode"] = formatCode,
                    ["formulaErrorCells"] = contents.FormulaErrorCells,
                });
        }
        finally { ReleaseCom((object?)range); }
    }

    private object AutofitRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        dynamic? entireColumns = null;
        dynamic? entireRows = null;
        try
        {
            var columns = RequiredBoolean(arguments, "columns");
            var rows = RequiredBoolean(arguments, "rows");
            var dimensions = GetRangeDimensions((object)range);
            AssertAutofitDimensions(dimensions.RowCount, dimensions.ColumnCount, columns, rows);
            var impact = CreateAutofitImpact(range, dimensions.RowCount, dimensions.ColumnCount, columns, rows);
            if (columns)
            {
                entireColumns = range.EntireColumn;
                entireColumns.AutoFit();
            }
            if (rows)
            {
                entireRows = range.EntireRow;
                entireRows.AutoFit();
            }
            return RangeResult(
                range,
                new { rowCount = dimensions.RowCount, columnCount = dimensions.ColumnCount },
                impact,
                CreateAutofitVerification(entireColumns, entireRows, columns, rows));
        }
        finally
        {
            ReleaseCom((object?)entireRows);
            ReleaseCom((object?)entireColumns);
            ReleaseCom((object?)range);
        }
    }

    private object ClearRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        try
        {
            var inspection = InspectMutationRange(range);
            var applyTo = RequiredString(arguments, "applyTo");
            switch (applyTo)
            {
                case "All": range.Clear(); break;
                case "Contents": range.ClearContents(); break;
                case "Formats": range.ClearFormats(); break;
                default: throw new LegacyWorkbookException("TOOL_ARGUMENT_ENUM", "清除模式无效。");
            }
            var contents = ReadRangeContents(range, inspection.RowCount, inspection.ColumnCount);
            var matches = applyTo switch
            {
                "All" or "Contents" => MatrixIsBlank(contents.Values) && MatrixIsBlank(contents.Formulas),
                "Formats" => MatricesEqual(contents.Values, inspection.Contents.Values) && MatricesEqual(contents.Formulas, inspection.Contents.Formulas),
                _ => false,
            };
            AssertVerification(matches, "CLEAR_VERIFICATION_FAILED", "Excel 未能确认目标范围已按请求清除。");
            return RangeResult(
                range,
                new { rowCount = inspection.RowCount, columnCount = inspection.ColumnCount },
                inspection.Impact,
                new Dictionary<string, object?>
                {
                    ["kind"] = "clear",
                    ["matches"] = true,
                    ["applyTo"] = applyTo,
                    ["formulaErrorCells"] = contents.FormulaErrorCells,
                });
        }
        finally { ReleaseCom((object?)range); }
    }

    private object AddWorksheet(JsonElement arguments)
    {
        var name = RequiredString(arguments, "name");
        EnsureWorksheetMissing(name);
        dynamic worksheets = workbook!.Worksheets;
        dynamic? worksheet = null;
        try
        {
            worksheet = worksheets.Add();
            try { worksheet.Name = name; } catch { worksheet.Delete(); throw; }
            return new { ok = true, target = worksheet.Name, worksheet = worksheet.Name };
        }
        finally
        {
            ReleaseCom((object?)worksheet);
            ReleaseCom((object?)worksheets);
        }
    }

    private object RenameWorksheet(JsonElement arguments)
    {
        var currentName = RequiredString(arguments, "currentName");
        var newName = RequiredString(arguments, "newName");
        var worksheet = GetWorksheet(currentName);
        try
        {
            if (!currentName.Equals(newName, StringComparison.OrdinalIgnoreCase)) EnsureWorksheetMissing(newName);
            worksheet.Name = newName;
            return new { ok = true, target = worksheet.Name, worksheet = worksheet.Name };
        }
        finally { ReleaseCom((object?)worksheet); }
    }

    private object CreateTable(JsonElement arguments)
    {
        var range = GetRange(arguments);
        dynamic? worksheet = null;
        dynamic? listObjects = null;
        dynamic? table = null;
        TableRollbackSnapshot? rollback = null;
        var rollbackPending = false;
        try
        {
            var requestedName = OptionalString(arguments, "name");
            if (requestedName is not null) EnsureTableNameAvailable(requestedName);
            var inspection = InspectMutationRange(range);
            rollback = CaptureTableRollback((object?)range, inspection);
            worksheet = range.Worksheet;
            listObjects = worksheet.ListObjects;
            table = listObjects.Add(
                XlSrcRange,
                range,
                Type.Missing,
                RequiredBoolean(arguments, "hasHeaders") ? XlYes : XlNo,
                Type.Missing);
            try
            {
                if (requestedName is { } name) table.Name = name;
                if (OptionalString(arguments, "style") is { } style) table.TableStyle = style;
            }
            catch
            {
                rollbackPending = true;
                try
                {
                    table.Delete();
                    ReleaseCom((object?)table);
                    table = null;
                }
                catch
                {
                    // Keep the original configuration error as the tool result.
                }
                throw;
            }
            var requestedStyle = OptionalString(arguments, "style");
            var tableName = Convert.ToString(table.Name) ?? string.Empty;
            var tableStyle = NormalizeComValue(table.TableStyle);
            var matches = tableName.Length > 0 &&
                (requestedName is null || string.Equals(tableName, requestedName, StringComparison.OrdinalIgnoreCase)) &&
                (requestedStyle is null || string.Equals(Convert.ToString(tableStyle), requestedStyle, StringComparison.OrdinalIgnoreCase));
            AssertVerification(matches, "TABLE_VERIFICATION_FAILED", "Excel 未能确认新建表格的名称或样式。");
            return RangeResult(
                range,
                new { table = tableName, style = requestedStyle },
                inspection.Impact,
                new Dictionary<string, object?>
                {
                    ["kind"] = "table",
                    ["matches"] = true,
                    ["table"] = tableName,
                    ["style"] = tableStyle,
                });
        }
        finally
        {
            ReleaseCom((object?)table);
            ReleaseCom((object?)listObjects);
            ReleaseCom((object?)worksheet);
            if (rollbackPending && rollback is not null)
            {
                try { RestoreTableRollback((object)range, rollback); }
                catch (Exception) { }
            }
            ReleaseCom((object?)range);
        }
    }

    private object CreateChart(JsonElement arguments)
    {
        var range = GetRange(arguments, "sourceAddress");
        dynamic? worksheet = null;
        dynamic? chartObjects = null;
        dynamic? chartObject = null;
        dynamic? chart = null;
        dynamic? position = null;
        try
        {
            var inspection = InspectMutationRange(range);
            worksheet = range.Worksheet;
            double left = Convert.ToDouble(range.Left);
            double top = Convert.ToDouble(range.Top) + Convert.ToDouble(range.Height) + 12;
            double width = 480;
            double height = 280;
            if (OptionalString(arguments, "positionAddress") is { } positionAddress)
            {
                position = worksheet.Range[positionAddress];
                left = Convert.ToDouble(position.Left);
                top = Convert.ToDouble(position.Top);
                width = Math.Max(240, Convert.ToDouble(position.Width));
                height = Math.Max(160, Convert.ToDouble(position.Height));
            }
            chartObjects = worksheet.ChartObjects();
            chartObject = chartObjects.Add(left, top, width, height);
            chart = chartObject.Chart;
            try
            {
                chart.ChartType = ChartType(RequiredString(arguments, "chartType"));
                var seriesBy = RequiredString(arguments, "seriesBy");
                if (seriesBy == "Auto") chart.SetSourceData(range);
                else chart.SetSourceData(range, SeriesBy(seriesBy));
                if (OptionalString(arguments, "title") is { } title)
                {
                    chart.HasTitle = true;
                    chart.ChartTitle.Text = title;
                }
            }
            catch
            {
                chartObject.Delete();
                throw;
            }
            var requestedChartType = RequiredString(arguments, "chartType");
            var chartName = Convert.ToString(chartObject.Name) ?? string.Empty;
            var matches = chartName.Length > 0 && Convert.ToInt32(chart.ChartType) == ChartType(requestedChartType);
            AssertVerification(matches, "CHART_VERIFICATION_FAILED", "Excel 未能确认新建图表的类型或对象标识。");
            return RangeResult(
                range,
                new { chart = chartName, chartType = requestedChartType },
                inspection.Impact,
                new Dictionary<string, object?>
                {
                    ["kind"] = "chart",
                    ["matches"] = true,
                    ["chart"] = chartName,
                    ["chartType"] = requestedChartType,
                });
        }
        finally
        {
            ReleaseCom((object?)position);
            ReleaseCom((object?)chart);
            ReleaseCom((object?)chartObject);
            ReleaseCom((object?)chartObjects);
            ReleaseCom((object?)worksheet);
            ReleaseCom((object?)range);
        }
    }

    private object SortRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        dynamic? key = null;
        try
        {
            var inspection = InspectMutationRange(range);
            var keyColumn = RequiredInt32(arguments, "keyColumn");
            if (keyColumn > inspection.ColumnCount)
            {
                throw new LegacyWorkbookException("SORT_KEY_OUT_OF_RANGE", $"排序列 {keyColumn} 超出目标范围的 {inspection.ColumnCount} 列。");
            }
            var direction = RequiredString(arguments, "direction");
            key = range.Columns[keyColumn];
            range.Sort(
                Key1: key,
                Order1: direction == "Ascending" ? XlAscending : XlDescending,
                Header: RequiredBoolean(arguments, "hasHeaders") ? XlYes : XlNo,
                Orientation: XlSortRows);
            var contents = ReadRangeContents(range, inspection.RowCount, inspection.ColumnCount);
            return RangeResult(
                range,
                new { keyColumn, direction },
                inspection.Impact,
                new Dictionary<string, object?>
                {
                    ["kind"] = "sort",
                    ["matches"] = true,
                    ["keyColumn"] = keyColumn,
                    ["direction"] = direction,
                    ["keyValues"] = SampleColumn(contents.Values, keyColumn - 1),
                    ["formulaErrorCells"] = contents.FormulaErrorCells,
                });
        }
        finally
        {
            ReleaseCom((object?)key);
            ReleaseCom((object?)range);
        }
    }

    private dynamic GetRange(JsonElement arguments, string addressProperty = "address")
    {
        var worksheetName = OptionalString(arguments, "worksheet");
        var worksheet = worksheetName is null ? GetActiveWorksheet() : GetWorksheet(worksheetName);
        try
        {
            return worksheet.Range[RequiredString(arguments, addressProperty)];
        }
        finally { ReleaseCom((object?)worksheet); }
    }

    private dynamic GetSelectedRange(out bool selectionIsRange)
    {
        dynamic? window = null;
        dynamic? selection = null;
        try
        {
            window = GetWorkbookWindow();
            selection = window.Selection;
            if (IsExcelRange(selection))
            {
                selectionIsRange = true;
                var selectedRange = selection;
                selection = null;
                return selectedRange;
            }

            selectionIsRange = false;
            return window.ActiveCell;
        }
        finally
        {
            ReleaseCom((object?)selection);
            ReleaseCom((object?)window);
        }
    }

    private dynamic GetActiveWorksheet()
    {
        dynamic? window = null;
        dynamic? worksheet = null;
        try
        {
            window = GetWorkbookWindow();
            worksheet = window.ActiveSheet;
            if (!IsExcelWorksheet(worksheet))
            {
                throw new LegacyWorkbookException("WORKSHEET_UNAVAILABLE", "当前活动对象不是工作表。");
            }

            var activeWorksheet = worksheet;
            worksheet = null;
            return activeWorksheet;
        }
        finally
        {
            ReleaseCom((object?)worksheet);
            ReleaseCom((object?)window);
        }
    }

    private dynamic GetWorkbookWindow()
    {
        dynamic? windows = null;
        try
        {
            windows = workbook!.Windows;
            if (Convert.ToInt32(windows.Count) < 1)
            {
                throw new LegacyWorkbookException("WORKBOOK_WINDOW_UNAVAILABLE", "绑定的 .xls 工作簿没有可用窗口。");
            }
            return windows[1];
        }
        catch (COMException error)
        {
            throw new LegacyWorkbookException("WORKBOOK_WINDOW_UNAVAILABLE", $"无法访问绑定工作簿窗口：{SafeComMessage(error)}");
        }
        catch (RuntimeBinderException)
        {
            throw new LegacyWorkbookException("WORKBOOK_WINDOW_UNAVAILABLE", "无法访问绑定工作簿窗口。");
        }
        finally
        {
            ReleaseCom((object?)windows);
        }
    }

    private dynamic GetWorksheet(string name)
    {
        dynamic worksheets = workbook!.Worksheets;
        try { return worksheets[name]; }
        catch (COMException) { throw new LegacyWorkbookException("WORKSHEET_NOT_FOUND", $"找不到工作表“{name}”。"); }
        finally { ReleaseCom((object?)worksheets); }
    }

    private void EnsureWorksheetMissing(string name)
    {
        dynamic? worksheet = null;
        dynamic worksheets = workbook!.Worksheets;
        try
        {
            worksheet = worksheets[name];
            throw new LegacyWorkbookException("WORKSHEET_EXISTS", $"工作表“{name}”已存在。");
        }
        catch (COMException)
        {
            // Item throws when the worksheet does not exist.
        }
        finally
        {
            ReleaseCom((object?)worksheet);
            ReleaseCom((object?)worksheets);
        }
    }

    private void EnsureTableNameAvailable(string name)
    {
        dynamic? worksheets = null;
        try
        {
            worksheets = workbook!.Worksheets;
            var worksheetCount = Convert.ToInt32(worksheets.Count);
            for (var worksheetIndex = 1; worksheetIndex <= worksheetCount; worksheetIndex += 1)
            {
                dynamic? worksheet = null;
                dynamic? listObjects = null;
                dynamic? table = null;
                try
                {
                    worksheet = worksheets[worksheetIndex];
                    listObjects = worksheet.ListObjects;
                    var tableCount = Convert.ToInt32(listObjects.Count);
                    for (var tableIndex = 1; tableIndex <= tableCount; tableIndex += 1)
                    {
                        table = listObjects[tableIndex];
                        if (string.Equals(Convert.ToString(table.Name), name, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new LegacyWorkbookException("TABLE_NAME_EXISTS", $"表格名称“{name}”已存在。");
                        }
                        ReleaseCom((object?)table);
                        table = null;
                    }
                }
                finally
                {
                    ReleaseCom((object?)table);
                    ReleaseCom((object?)listObjects);
                    ReleaseCom((object?)worksheet);
                }
            }
        }
        finally
        {
            ReleaseCom((object?)worksheets);
        }
    }

    private MutationInspection InspectMutationRange(dynamic range, bool numberFormat = false)
    {
        var dimensions = GetRangeDimensions((object)range);
        var limit = numberFormat ? MaxNumberFormatCells : MaxMutationCells;
        if (dimensions.CellCount > limit)
        {
            var code = numberFormat ? "NUMBER_FORMAT_RANGE_TOO_LARGE" : "MODIFY_RANGE_TOO_LARGE";
            var operation = numberFormat ? "数字格式" : "修改";
            throw new LegacyWorkbookException(
                code,
                $"目标范围包含 {dimensions.CellCount} 个单元格，超过 {limit} 个{operation}限制；请缩小范围或分块执行。");
        }

        var contents = ReadRangeContents(range, dimensions.RowCount, dimensions.ColumnCount);
        return new MutationInspection(
            dimensions.RowCount,
            dimensions.ColumnCount,
            dimensions.CellCount,
            CreateMutationImpact(range, dimensions.RowCount, dimensions.ColumnCount, dimensions.CellCount, contents),
            contents);
    }

    private static (int RowCount, int ColumnCount, long CellCount) GetRangeDimensions(object rangeObject)
    {
        dynamic range = rangeObject;
        var rowCount = Convert.ToInt32(range.Rows.Count);
        var columnCount = Convert.ToInt32(range.Columns.Count);
        return (rowCount, columnCount, checked((long)rowCount * columnCount));
    }

    private static void AssertAutofitDimensions(int rowCount, int columnCount, bool columns, bool rows)
    {
        if (columns && columnCount > MaxAutofitDimensions)
        {
            throw new LegacyWorkbookException(
                "AUTOFIT_TARGET_TOO_LARGE",
                $"自动调整将影响 {columnCount} 列，超过 {MaxAutofitDimensions} 个列限制；请缩小范围。");
        }
        if (rows && rowCount > MaxAutofitDimensions)
        {
            throw new LegacyWorkbookException(
                "AUTOFIT_TARGET_TOO_LARGE",
                $"自动调整将影响 {rowCount} 行，超过 {MaxAutofitDimensions} 个行限制；请缩小范围。");
        }
    }

    private static Dictionary<string, object?> CreateMutationImpact(
        dynamic range,
        int rowCount,
        int columnCount,
        long cellCount,
        RangeContents contents)
    {
        dynamic? worksheet = null;
        try
        {
            worksheet = range.Worksheet;
            return new Dictionary<string, object?>
            {
                ["target"] = $"{worksheet.Name}!{RangeAddress(range)}",
                ["rowCount"] = rowCount,
                ["columnCount"] = columnCount,
                ["cellCount"] = cellCount,
                ["nonEmptyCells"] = contents.NonEmptyCells,
                ["formulaCells"] = contents.FormulaCells,
                ["formulaErrorCells"] = contents.FormulaErrorCells,
            };
        }
        finally { ReleaseCom((object?)worksheet); }
    }

    private static Dictionary<string, object?> CreateAutofitImpact(
        dynamic range,
        int rowCount,
        int columnCount,
        bool columns,
        bool rows)
    {
        dynamic? worksheet = null;
        try
        {
            worksheet = range.Worksheet;
            return new Dictionary<string, object?>
            {
                ["target"] = $"{worksheet.Name}!{RangeAddress(range)}",
                ["rowCount"] = rowCount,
                ["columnCount"] = columnCount,
                ["columns"] = columns ? columnCount : 0,
                ["rows"] = rows ? rowCount : 0,
                ["dimensionCount"] = (columns ? columnCount : 0) + (rows ? rowCount : 0),
            };
        }
        finally { ReleaseCom((object?)worksheet); }
    }

    private static Dictionary<string, object?> CreateAutofitVerification(
        dynamic? entireColumns,
        dynamic? entireRows,
        bool columns,
        bool rows)
    {
        var verification = new Dictionary<string, object?>
        {
            ["kind"] = "autofit",
            ["matches"] = true,
            ["columns"] = columns,
            ["rows"] = rows,
        };
        if (columns)
        {
            if (entireColumns is null) throw new InvalidOperationException("自动调整列宽后无法读取列宽。");
            verification["columnWidth"] = NormalizeComValue(entireColumns.ColumnWidth);
        }
        if (rows)
        {
            if (entireRows is null) throw new InvalidOperationException("自动调整行高后无法读取行高。");
            verification["rowHeight"] = NormalizeComValue(entireRows.RowHeight);
        }
        return verification;
    }

    private static Dictionary<string, object?> VerifyRangeFormat(dynamic range, JsonElement arguments)
    {
        dynamic? interior = null;
        dynamic? font = null;
        try
        {
            var properties = new Dictionary<string, object?>();
            var matches = true;

            if (OptionalString(arguments, "fillColor") is { } fillColor)
            {
                interior = range.Interior;
                var actual = Convert.ToInt32(interior.Color);
                properties["fillColor"] = OleColorToHtml(actual);
                matches &= actual == ColorTranslator.ToOle(ColorTranslator.FromHtml(fillColor));
            }
            if (OptionalString(arguments, "fontColor") is { } fontColor)
            {
                font ??= range.Font;
                var actual = Convert.ToInt32(font.Color);
                properties["fontColor"] = OleColorToHtml(actual);
                matches &= actual == ColorTranslator.ToOle(ColorTranslator.FromHtml(fontColor));
            }
            if (OptionalBoolean(arguments, "bold") is { } bold)
            {
                font ??= range.Font;
                var actual = Convert.ToBoolean(font.Bold);
                properties["bold"] = actual;
                matches &= actual == bold;
            }
            if (OptionalBoolean(arguments, "italic") is { } italic)
            {
                font ??= range.Font;
                var actual = Convert.ToBoolean(font.Italic);
                properties["italic"] = actual;
                matches &= actual == italic;
            }
            if (OptionalDouble(arguments, "fontSize") is { } fontSize)
            {
                font ??= range.Font;
                var actual = Convert.ToDouble(font.Size);
                properties["fontSize"] = actual;
                matches &= actual.Equals(fontSize);
            }
            if (OptionalString(arguments, "horizontalAlignment") is { } horizontal)
            {
                var actual = Convert.ToInt32(range.HorizontalAlignment);
                properties["horizontalAlignment"] = actual;
                matches &= actual == HorizontalAlignment(horizontal);
            }
            if (OptionalString(arguments, "verticalAlignment") is { } vertical)
            {
                var actual = Convert.ToInt32(range.VerticalAlignment);
                properties["verticalAlignment"] = actual;
                matches &= actual == VerticalAlignment(vertical);
            }
            if (OptionalBoolean(arguments, "wrapText") is { } wrapText)
            {
                var actual = Convert.ToBoolean(range.WrapText);
                properties["wrapText"] = actual;
                matches &= actual == wrapText;
            }

            AssertVerification(matches, "FORMAT_VERIFICATION_FAILED", "Excel 未能确认范围格式已按请求应用。");
            return new Dictionary<string, object?>
            {
                ["kind"] = "format",
                ["matches"] = true,
                ["properties"] = properties,
            };
        }
        finally
        {
            ReleaseCom((object?)font);
            ReleaseCom((object?)interior);
        }
    }

    private static string OleColorToHtml(int value)
    {
        var color = ColorTranslator.FromOle(value);
        return $"#{color.R:X2}{color.G:X2}{color.B:X2}";
    }

    private static RangeContents ReadRangeContents(dynamic range, int rowCount, int columnCount)
    {
        var values = ToRows(range.Value2, rowCount, columnCount);
        var formulas = ToRows(range.Formula, rowCount, columnCount);
        var nonEmptyCells = 0;
        var formulaCells = 0;
        var formulaErrorCells = 0;
        for (var row = 0; row < rowCount; row += 1)
        {
            for (var column = 0; column < columnCount; column += 1)
            {
                var value = values[row][column];
                var formula = formulas[row][column];
                if (value is not null && value is not "") nonEmptyCells += 1;
                var isFormula = formula is string text && text.StartsWith("=", StringComparison.Ordinal);
                if (isFormula) formulaCells += 1;
                if (isFormula && IsFormulaErrorValue(value)) formulaErrorCells += 1;
            }
        }
        return new RangeContents(values, formulas, nonEmptyCells, formulaCells, formulaErrorCells);
    }

    private static bool IsFormulaErrorValue(object? value) => value switch
    {
        string text => FormulaErrorValues.Contains(text) ||
            (text.StartsWith("#ERROR(", StringComparison.OrdinalIgnoreCase) && text.EndsWith(")", StringComparison.Ordinal)),
        int code when code < 0 => FormulaErrorCodes.Contains(unchecked((ushort)code)),
        long code when code < 0 => FormulaErrorCodes.Contains(unchecked((ushort)code)),
        double code when code < 0 && code == Math.Truncate(code) => FormulaErrorCodes.Contains(unchecked((ushort)code)),
        _ => false,
    };

    private static bool MatrixMatches(object?[][] actual, object?[,] expected, int rowCount, int columnCount)
    {
        if (actual.Length != rowCount) return false;
        for (var row = 0; row < rowCount; row += 1)
        {
            if (actual[row].Length != columnCount) return false;
            for (var column = 0; column < columnCount; column += 1)
            {
                if (!ScalarValuesMatch(actual[row][column], expected[row, column])) return false;
            }
        }
        return true;
    }

    private static bool MatricesEqual(object?[][] left, object?[][] right)
    {
        if (left.Length != right.Length) return false;
        for (var row = 0; row < left.Length; row += 1)
        {
            if (left[row].Length != right[row].Length) return false;
            for (var column = 0; column < left[row].Length; column += 1)
            {
                if (!ScalarValuesMatch(left[row][column], right[row][column])) return false;
            }
        }
        return true;
    }

    private static bool MatrixIsBlank(object?[][] matrix)
    {
        foreach (var row in matrix)
        {
            foreach (var value in row)
            {
                if (value is not null && value is not "") return false;
            }
        }
        return true;
    }

    private static bool ScalarValuesMatch(object? actual, object? expected)
    {
        actual = NormalizeComValue(actual);
        expected = NormalizeComValue(expected);
        if (actual is null || expected is null) return actual is null && expected is null;
        if (IsNumericValue(actual) && IsNumericValue(expected)) return Convert.ToDouble(actual) == Convert.ToDouble(expected);
        return Equals(actual, expected);
    }

    private static bool IsNumericValue(object value) => value is
        byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal;

    private static bool NumberFormatsMatch(object?[][] numberFormats, string formatCode, int rowCount, int columnCount)
    {
        if (numberFormats.Length != rowCount) return false;
        for (var row = 0; row < rowCount; row += 1)
        {
            if (numberFormats[row].Length != columnCount) return false;
            for (var column = 0; column < columnCount; column += 1)
            {
                if (!string.Equals(Convert.ToString(numberFormats[row][column]), formatCode, StringComparison.Ordinal)) return false;
            }
        }
        return true;
    }

    private static TableRollbackSnapshot CaptureTableRollback(object rangeObject, MutationInspection inspection)
    {
        dynamic range = rangeObject;
        return new(
            inspection.Contents.Values,
            inspection.Contents.Formulas,
            ReadNumberFormatRows(range, inspection.RowCount, inspection.ColumnCount));
    }

    private static void RestoreTableRollback(object rangeObject, TableRollbackSnapshot snapshot)
    {
        dynamic range = rangeObject;
        var rowCount = snapshot.Values.Length;
        var columnCount = rowCount == 0 ? 0 : snapshot.Values[0].Length;
        var contents = new object?[rowCount, columnCount];
        var numberFormats = new object?[rowCount, columnCount];
        for (var row = 0; row < rowCount; row += 1)
        {
            for (var column = 0; column < columnCount; column += 1)
            {
                var formula = snapshot.Formulas[row][column];
                contents[row, column] = formula is string text && text.StartsWith("=", StringComparison.Ordinal)
                    ? text
                    : snapshot.Values[row][column];
                numberFormats[row, column] = snapshot.NumberFormats[row][column];
            }
        }
        range.Formula = contents;
        range.NumberFormat = numberFormats;
    }

    private static object?[] SampleColumn(object?[][] values, int column)
    {
        var count = Math.Min(values.Length, 20);
        var sample = new object?[count];
        for (var row = 0; row < count; row += 1) sample[row] = values[row][column];
        return sample;
    }

    private static void AssertVerification(bool matches, string code, string message)
    {
        if (!matches) throw new LegacyWorkbookException(code, message);
    }

    private object RangeResult(
        dynamic range,
        object? details = null,
        Dictionary<string, object?>? impact = null,
        Dictionary<string, object?>? verification = null)
    {
        dynamic worksheet = range.Worksheet;
        try
        {
            var result = new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["target"] = $"{worksheet.Name}!{RangeAddress(range)}",
                ["worksheet"] = worksheet.Name,
            };
            if (details is not null)
            {
                foreach (var property in details.GetType().GetProperties()) result[property.Name] = property.GetValue(details);
            }
            if (impact is not null)
            {
                result["impact"] = impact;
                if (!result.ContainsKey("rowCount")) result["rowCount"] = impact["rowCount"];
                if (!result.ContainsKey("columnCount")) result["columnCount"] = impact["columnCount"];
            }
            if (verification is not null) result["verification"] = verification;
            return result;
        }
        finally { ReleaseCom((object?)worksheet); }
    }

    private sealed record RangeContents(
        object?[][] Values,
        object?[][] Formulas,
        int NonEmptyCells,
        int FormulaCells,
        int FormulaErrorCells);

    private sealed record TableRollbackSnapshot(
        object?[][] Values,
        object?[][] Formulas,
        object?[][] NumberFormats);

    private sealed record MutationInspection(
        int RowCount,
        int ColumnCount,
        long CellCount,
        Dictionary<string, object?> Impact,
        RangeContents Contents);

    private static object?[][] ToRows(object? value, int rows, int columns)
    {
        var output = new object?[rows][];
        for (var row = 0; row < rows; row += 1)
        {
            output[row] = new object?[columns];
            for (var column = 0; column < columns; column += 1)
            {
                var cell = value is Array array
                    ? array.GetValue(row + array.GetLowerBound(0), column + array.GetLowerBound(1))
                    : value;
                output[row][column] = NormalizeComValue(cell);
            }
        }
        return output;
    }

    private static object?[][] ReadNumberFormatRows(dynamic range, int rows, int columns)
    {
        object? numberFormat = range.NumberFormat;
        if (numberFormat is not null && numberFormat is not DBNull) return ToRows(numberFormat, rows, columns);

        var output = new object?[rows][];
        dynamic? cells = null;
        dynamic? cell = null;
        try
        {
            cells = range.Cells;
            for (var row = 0; row < rows; row += 1)
            {
                output[row] = new object?[columns];
                for (var column = 0; column < columns; column += 1)
                {
                    cell = cells[row + 1, column + 1];
                    output[row][column] = NormalizeComValue(cell.NumberFormat);
                    ReleaseCom((object?)cell);
                    cell = null;
                }
            }
            return output;
        }
        finally
        {
            ReleaseCom((object?)cell);
            ReleaseCom((object?)cells);
        }
    }

    private static object? NormalizeComValue(object? value) => value switch
    {
        null or DBNull => null,
        string or bool or int or long or double => value,
        float number => (double)number,
        decimal number => (double)number,
        DateTime date => date.ToString("O"),
        ErrorWrapper error => $"#ERROR({error.ErrorCode})",
        _ => Convert.ToString(value),
    };

    private static object?[,] RequiredMatrix(JsonElement arguments, string property)
    {
        if (!arguments.TryGetProperty(property, out var matrix) || matrix.ValueKind != JsonValueKind.Array || matrix.GetArrayLength() == 0)
        {
            throw new LegacyWorkbookException("TOOL_ARGUMENT_TYPE", $"{property} 必须是非空二维数组。");
        }
        var rows = matrix.GetArrayLength();
        var columns = matrix[0].GetArrayLength();
        var output = new object?[rows, columns];
        for (var row = 0; row < rows; row += 1)
        {
            var sourceRow = matrix[row];
            if (sourceRow.ValueKind != JsonValueKind.Array || sourceRow.GetArrayLength() != columns)
            {
                throw new LegacyWorkbookException("MATRIX_NOT_RECTANGULAR", $"{property} 必须是规则二维数组。");
            }
            for (var column = 0; column < columns; column += 1) output[row, column] = JsonScalar(sourceRow[column]);
        }
        return output;
    }

    private static object? JsonScalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.String => value.GetString(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number when value.TryGetInt64(out var integer) => integer,
        JsonValueKind.Number => value.GetDouble(),
        _ => throw new LegacyWorkbookException("TOOL_ARGUMENT_TYPE", "二维数组只允许字符串、数字、布尔值和 null。"),
    };

    private static string RequiredString(JsonElement arguments, string property)
    {
        if (!arguments.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(value.GetString()))
        {
            throw new LegacyWorkbookException("TOOL_ARGUMENT_TYPE", $"{property} 必须是非空字符串。");
        }
        return value.GetString()!;
    }

    private static string? OptionalString(JsonElement arguments, string property)
    {
        if (!arguments.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String) throw new LegacyWorkbookException("TOOL_ARGUMENT_TYPE", $"{property} 必须是字符串或 null。");
        return value.GetString();
    }

    private static bool RequiredBoolean(JsonElement arguments, string property)
    {
        if (!arguments.TryGetProperty(property, out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new LegacyWorkbookException("TOOL_ARGUMENT_TYPE", $"{property} 必须是布尔值。");
        }
        return value.GetBoolean();
    }

    private static bool? OptionalBoolean(JsonElement arguments, string property)
    {
        if (!arguments.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new LegacyWorkbookException("TOOL_ARGUMENT_TYPE", $"{property} 必须是布尔值或 null。");
        return value.GetBoolean();
    }

    private static double? OptionalDouble(JsonElement arguments, string property)
    {
        if (!arguments.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.Number) throw new LegacyWorkbookException("TOOL_ARGUMENT_TYPE", $"{property} 必须是数字或 null。");
        return value.GetDouble();
    }

    private static int RequiredInt32(JsonElement arguments, string property)
    {
        if (!arguments.TryGetProperty(property, out var value) || !value.TryGetInt32(out var result))
        {
            throw new LegacyWorkbookException("TOOL_ARGUMENT_TYPE", $"{property} 必须是整数。");
        }
        return result;
    }

    private static string RangeAddress(dynamic range) => range.Address[false, false, XlReferenceStyleA1, false];

    private static int HorizontalAlignment(string value) => value switch
    {
        "Left" => XlHAlignLeft,
        "Center" => XlHAlignCenter,
        "Right" => XlHAlignRight,
        "General" => XlHAlignGeneral,
        _ => throw new LegacyWorkbookException("TOOL_ARGUMENT_ENUM", "水平对齐方式无效。"),
    };

    private static int VerticalAlignment(string value) => value switch
    {
        "Top" => XlVAlignTop,
        "Center" => XlVAlignCenter,
        "Bottom" => XlVAlignBottom,
        _ => throw new LegacyWorkbookException("TOOL_ARGUMENT_ENUM", "垂直对齐方式无效。"),
    };

    private static int ChartType(string value) => value switch
    {
        "ColumnClustered" => XlColumnClustered,
        "BarClustered" => XlBarClustered,
        "Line" => XlLine,
        "Pie" => XlPie,
        "Doughnut" => XlDoughnut,
        "Area" => XlArea,
        "XYScatter" => XlXYScatter,
        _ => throw new LegacyWorkbookException("TOOL_ARGUMENT_ENUM", "图表类型无效。"),
    };

    private static int SeriesBy(string value) => value switch
    {
        "Rows" => XlRows,
        "Columns" => XlColumns,
        _ => throw new LegacyWorkbookException("TOOL_ARGUMENT_ENUM", "图表序列方向无效。"),
    };

    private void OnSheetChange(object sheet, object target)
    {
        if (IsBoundWorkbook(sheet) && !suppressEvents) revision += 1;
    }

    private void OnSheetActivate(object sheet)
    {
        if (IsBoundWorkbook(sheet)) activeSheetRevision += 1;
    }

    private void OnWorkbookBeforeClose(object closingWorkbook, ref bool cancel)
    {
        if (cancel || !IsBoundWorkbook(closingWorkbook)) return;
        workbookClosePending = true;
        QueueWorkbookCloseConfirmation();
    }

    private void QueueWorkbookCloseConfirmation()
    {
        if (!IsHandleCreated || IsDisposed) return;
        try { BeginInvoke((MethodInvoker)ConfirmPendingWorkbookClose); }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    private void ConfirmPendingWorkbookClose()
    {
        if (!workbookClosePending || released || IsBoundWorkbookOpen()) return;
        workbookClosePending = false;
        workbookClosed = true;
        if (!IsDisposed) Close();
    }

    private bool IsBoundWorkbookOpen()
    {
        if (excel is null || workbook is null) return false;

        dynamic? workbooks = null;
        try
        {
            workbooks = excel.Workbooks;
            var count = Convert.ToInt32(workbooks.Count);
            for (var index = 1; index <= count; index += 1)
            {
                dynamic? candidate = null;
                var candidateIsBoundWorkbook = false;
                try
                {
                    candidate = workbooks[index];
                    candidateIsBoundWorkbook = IsSameComObject(candidate, (object)workbook);
                    if (candidateIsBoundWorkbook) return true;
                }
                finally
                {
                    if (!candidateIsBoundWorkbook) ReleaseCom((object?)candidate);
                }
            }
            return false;
        }
        catch (Exception error) when (error is COMException or RuntimeBinderException or InvalidComObjectException)
        {
            // Excel can reject COM calls while showing its own save dialog. Keep the pane alive until a later check succeeds.
            return true;
        }
        finally
        {
            ReleaseCom((object?)workbooks);
        }
    }

    private void TrackExcelWindow()
    {
        ConfirmPendingWorkbookClose();
        if (workbookClosed || IsDisposed) return;
        if (excelWindow == IntPtr.Zero || !NativeMethods.IsWindow(excelWindow))
        {
            workbookClosed = true;
            Close();
            return;
        }
        if (!NativeMethods.GetWindowRect(excelWindow, out var rectangle)) return;
        var workingArea = Screen.FromHandle(excelWindow).WorkingArea;
        var height = Math.Max(MinimumSize.Height, Math.Min(rectangle.Bottom - rectangle.Top, workingArea.Height));
        var x = Math.Min(rectangle.Right + 8, workingArea.Right - PaneWidth);
        var y = Math.Max(workingArea.Top, rectangle.Top);
        if (Bounds.X != x || Bounds.Y != y || Bounds.Width != PaneWidth || Bounds.Height != height)
        {
            Bounds = new Rectangle(x, y, PaneWidth, height);
        }
    }

    private void ReleaseHost()
    {
        if (released) return;
        released = true;
        windowTimer.Stop();
        pipeServer.Dispose();
        ReleaseExcelReferences();
    }

    private void ReleaseExcelReferences()
    {
        if (excel is not null)
        {
            RemoveComEvent(SheetChangeDispId, sheetChangeHandler);
            RemoveComEvent(SheetActivateDispId, sheetActivateHandler);
            RemoveComEvent(WorkbookBeforeCloseDispId, workbookBeforeCloseHandler);
        }
        ReleaseCom((object?)workbook);
        ReleaseCom((object?)excel);
        workbook = null;
        excel = null;
        GC.Collect();
        GC.WaitForPendingFinalizers();
    }

    private static void ReleaseCom(object? value)
    {
        try
        {
            if (value is not null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }
        catch { }
    }

    private static void ReleaseComReference(object? value)
    {
        try
        {
            if (value is not null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
        }
        catch { }
    }

    private void RemoveComEvent(int dispId, Delegate? handler)
    {
        if (excel is null || handler is null) return;
        try { ComEventsHelper.Remove(excel, AppEventsIid, dispId, handler); } catch { }
    }

    private bool IsBoundWorkbook(object? source)
    {
        if (workbook is null || source is null) return false;
        if (IsSameComObject(source, (object)workbook)) return true;

        try
        {
            dynamic candidate = source;
            object? parent = candidate.Parent;
            // Excel may return an RCW already owned by the event source or another open
            // workbook. Releasing that borrowed wrapper can detach the live caller RCW.
            return IsSameComObject(parent, (object)workbook);
        }
        catch (Exception error) when (error is COMException or RuntimeBinderException or InvalidComObjectException)
        {
            return false;
        }
    }

    private void ReleaseComIfNotBoundWorkbook(object? value)
    {
        if (workbook is not null && IsSameComObject(value, (object)workbook)) return;
        ReleaseCom((object?)value);
    }

    private static bool IsSameComObject(object? left, object? right)
    {
        if (left is null || right is null) return false;
        if (ReferenceEquals(left, right)) return true;
        if (!Marshal.IsComObject(left) || !Marshal.IsComObject(right)) return false;

        var leftUnknown = IntPtr.Zero;
        var rightUnknown = IntPtr.Zero;
        try
        {
            leftUnknown = Marshal.GetIUnknownForObject(left);
            rightUnknown = Marshal.GetIUnknownForObject(right);
            return leftUnknown == rightUnknown;
        }
        catch (Exception error) when (error is ArgumentException or InvalidComObjectException)
        {
            return false;
        }
        finally
        {
            if (rightUnknown != IntPtr.Zero) Marshal.Release(rightUnknown);
            if (leftUnknown != IntPtr.Zero) Marshal.Release(leftUnknown);
        }
    }

    private static bool IsExcelRange(object? value)
    {
        if (value is null || !Marshal.IsComObject(value)) return false;
        try
        {
            dynamic candidate = value;
            _ = candidate.Address[false, false, XlReferenceStyleA1, false];
            return true;
        }
        catch (Exception error) when (error is COMException or RuntimeBinderException)
        {
            return false;
        }
    }

    private static bool IsExcelWorksheet(object? value)
    {
        if (value is null || !Marshal.IsComObject(value)) return false;
        dynamic? cells = null;
        try
        {
            dynamic candidate = value;
            cells = candidate.Cells;
            return cells is not null && Marshal.IsComObject(cells);
        }
        catch (Exception error) when (error is COMException or RuntimeBinderException)
        {
            return false;
        }
        finally
        {
            ReleaseCom((object?)cells);
        }
    }

    private static string SafeComMessage(Exception error)
    {
        var message = error.Message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length > 300 ? message[..300] : message;
    }

    internal static string RunSmokeTest(string workbookPath)
    {
        using var host = new LegacyWorkbookHost(workbookPath, LegacyProtocol.CreateSessionId());
        try
        {
            var formatBefore = (int)host.workbook!.FileFormat;
            var write = ExecuteSmokeTool(host, "write_values", """{"worksheet":null,"address":"B2","values":[["native-xls-ok"]]}""");
            var format = ExecuteSmokeTool(host, "format_range", """{"worksheet":null,"address":"B2","fillColor":"#DFF6E8","fontColor":"#107C41","bold":true,"italic":false,"fontSize":11,"horizontalAlignment":"Center","verticalAlignment":"Center","wrapText":false}""");
            var read = ExecuteSmokeTool(host, "read_range", """{"worksheet":null,"address":"A1:B2"}""");
            var crossWorkbook = VerifyCrossWorkbookIsolation(host);
            var numberFormatSafety = VerifyNumberFormatSafety(host);
            var operationPolicy = VerifyOperationPolicy(host);
            var tableRollback = VerifyTableRollback(host);
            var cancelledClose = VerifyCancelledCloseKeepsHostUsable(host);
            var displayAlerts = host.excel!.DisplayAlerts;
            host.excel.DisplayAlerts = false;
            try { host.workbook.Save(); }
            finally { host.excel.DisplayAlerts = displayAlerts; }
            var formatAfter = (int)host.workbook.FileFormat;
            var fullName = host.workbook.FullName;
            return JsonSerializer.Serialize(new
            {
                ok = true,
                fullName,
                formatBefore,
                formatAfter,
                write,
                format,
                read,
                crossWorkbook,
                numberFormatSafety,
                operationPolicy,
                tableRollback,
                cancelledClose,
            }, LegacyProtocol.JsonOptions);
        }
        finally
        {
            CloseSmokeExcel(host);
            host.ReleaseHost();
        }
    }

    private static object ExecuteSmokeTool(LegacyWorkbookHost host, string name, string argumentsJson)
    {
        using var arguments = JsonDocument.Parse(argumentsJson);
        var request = JsonSerializer.Serialize(new
        {
            action = "execute",
            name,
            arguments = arguments.RootElement,
        }, LegacyProtocol.JsonOptions);
        return host.HandlePipeRequest(ParseRequest(request));
    }

    private static object VerifyCrossWorkbookIsolation(LegacyWorkbookHost host)
    {
        dynamic? boundWorksheet = null;
        dynamic? boundCell = null;
        dynamic? otherWorkbook = null;
        dynamic? otherWorksheet = null;
        dynamic? otherCell = null;
        try
        {
            host.workbook!.Activate();
            boundWorksheet = host.GetActiveWorksheet();
            var boundSheetName = (string)boundWorksheet.Name;
            boundCell = boundWorksheet.Range["B2"];
            boundCell.Select();

            otherWorkbook = host.excel!.Workbooks.Add();
            otherWorksheet = otherWorkbook.Worksheets[1];
            otherWorkbook.Activate();
            otherCell = otherWorksheet.Range["C3"];
            otherCell.Select();
            otherCell.Value2 = "other-workbook-change";

            var revisionBeforeExplicitOtherWorkbookEvent = host.revision;
            host.OnSheetChange((object)otherWorksheet, (object)otherCell);
            var otherWorkbookChangeIgnored = host.revision == revisionBeforeExplicitOtherWorkbookEvent;

            var activeSheetRevisionBeforeExplicitOtherWorkbookEvent = host.activeSheetRevision;
            host.OnSheetActivate((object)otherWorksheet);
            var otherWorkbookActivationIgnored = host.activeSheetRevision == activeSheetRevisionBeforeExplicitOtherWorkbookEvent;

            var selection = ExecuteSmokeTool(host, "get_selection", "{}");
            using var selectionDocument = JsonDocument.Parse(JsonSerializer.Serialize(selection, LegacyProtocol.JsonOptions));
            var selectionTarget = selectionDocument.RootElement.GetProperty("target").GetString() ?? string.Empty;
            var boundSelectionReturned = selectionTarget.StartsWith($"{boundSheetName}!", StringComparison.OrdinalIgnoreCase) &&
                selectionTarget.EndsWith("B2", StringComparison.OrdinalIgnoreCase);

            var undoRejected = false;
            try
            {
                host.HandlePipeRequest(ParseRequest("""{"action":"undo"}"""));
            }
            catch (LegacyWorkbookException error) when (error.Code == "UNDO_UNAVAILABLE")
            {
                undoRejected = true;
            }

            var otherWorkbookValuePreserved = string.Equals(
                Convert.ToString(otherCell.Value2),
                "other-workbook-change",
                StringComparison.Ordinal);
            if (!boundSelectionReturned || !otherWorkbookChangeIgnored || !otherWorkbookActivationIgnored || !undoRejected || !otherWorkbookValuePreserved)
            {
                throw new InvalidOperationException("跨工作簿隔离 smoke 检查失败。");
            }

            return new
            {
                ok = true,
                selectionTarget,
                otherWorkbookChangeIgnored,
                otherWorkbookActivationIgnored,
                undoRejected,
                otherWorkbookValuePreserved,
            };
        }
        finally
        {
            try { if (otherWorkbook is not null) otherWorkbook.Close(SaveChanges: false); } catch { }
            ReleaseCom((object?)otherCell);
            ReleaseCom((object?)otherWorksheet);
            ReleaseCom((object?)otherWorkbook);
            ReleaseCom((object?)boundCell);
            ReleaseCom((object?)boundWorksheet);
            try { if (host.workbook is not null) host.workbook.Activate(); } catch { }
        }
    }

    private static object VerifyNumberFormatSafety(LegacyWorkbookHost host)
    {
        ExecuteSmokeTool(host, "write_values", """{"worksheet":null,"address":"D2:E2","values":[[1,2]]}""");
        var decimalFormat = ExecuteSmokeTool(host, "set_number_format", """{"worksheet":null,"address":"D2","formatCode":"0.00"}""");
        var percentFormat = ExecuteSmokeTool(host, "set_number_format", """{"worksheet":null,"address":"E2","formatCode":"0%"}""");
        var read = ExecuteSmokeTool(host, "read_range", """{"worksheet":null,"address":"D2:E2"}""");
        using var readDocument = JsonDocument.Parse(JsonSerializer.Serialize(read, LegacyProtocol.JsonOptions));
        var numberFormats = readDocument.RootElement.GetProperty("numberFormat");
        var mixedFormatsPreserved = numberFormats.ValueKind == JsonValueKind.Array &&
            numberFormats.GetArrayLength() == 1 &&
            numberFormats[0].ValueKind == JsonValueKind.Array &&
            numberFormats[0].GetArrayLength() == 2 &&
            numberFormats[0][0].ValueKind == JsonValueKind.String &&
            numberFormats[0][1].ValueKind == JsonValueKind.String &&
            !string.Equals(numberFormats[0][0].GetString(), numberFormats[0][1].GetString(), StringComparison.Ordinal);

        var oversizedRangeRejected = false;
        try
        {
            ExecuteSmokeTool(host, "set_number_format", """{"worksheet":null,"address":"A1:A5001","formatCode":"0.00"}""");
        }
        catch (LegacyWorkbookException error) when (error.Code == "NUMBER_FORMAT_RANGE_TOO_LARGE")
        {
            oversizedRangeRejected = true;
        }

        var verificationReturned = HasVerifiedRangeResult(decimalFormat, "numberFormat", 1) &&
            HasVerifiedRangeResult(percentFormat, "numberFormat", 1);
        if (!mixedFormatsPreserved || !oversizedRangeRejected || !verificationReturned)
        {
            throw new InvalidOperationException("数字格式 smoke 检查失败。");
        }

        return new { ok = true, mixedFormatsPreserved, oversizedRangeRejected, verificationReturned };
    }

    private static object VerifyOperationPolicy(LegacyWorkbookHost host)
    {
        var values = ExecuteSmokeTool(host, "write_values", """{"worksheet":null,"address":"M2:N3","values":[[1,2],[3,4]]}""");
        var formulas = ExecuteSmokeTool(host, "write_formulas", """{"worksheet":null,"address":"O2:O3","formulas":[["=1/0"],["=2+2"]]}""");
        var format = ExecuteSmokeTool(host, "format_range", """{"worksheet":null,"address":"P2","fillColor":"#DFF6E8","bold":true}""");
        ExecuteSmokeTool(host, "write_values", """{"worksheet":null,"address":"Q2:R2","values":[[1,2]]}""");
        var clear = ExecuteSmokeTool(host, "clear_range", """{"worksheet":null,"address":"Q2:R2","applyTo":"Contents"}""");
        var autofit = ExecuteSmokeTool(host, "autofit_range", """{"worksheet":null,"address":"N:R","columns":true,"rows":false}""");

        var tableName = $"ChatExcelPolicy{Guid.NewGuid():N}";
        var chartName = string.Empty;
        try
        {
            ExecuteSmokeTool(host, "write_values", """{"worksheet":null,"address":"S2:T3","values":[[1,2],[3,4]]}""");
            var table = ExecuteSmokeTool(host, "create_table", JsonSerializer.Serialize(new
            {
                worksheet = (string?)null,
                address = "S2:T3",
                hasHeaders = false,
                name = tableName,
                style = (string?)null,
            }, LegacyProtocol.JsonOptions));

            ExecuteSmokeTool(host, "write_values", """{"worksheet":null,"address":"U2:V3","values":[["项目","数值"],["A",1]]}""");
            var chart = ExecuteSmokeTool(host, "create_chart", """{"worksheet":null,"sourceAddress":"U2:V3","chartType":"ColumnClustered","seriesBy":"Auto","title":"策略 smoke"}""");
            chartName = ReadResultString(chart, "chart");

            var writeVerified = HasVerifiedRangeResult(values, "values", 4);
            var formulaVerified = HasVerifiedRangeResult(formulas, "formulas", 2) && ReadVerificationInt32(formulas, "formulaErrorCells") == 1;
            var formatVerified = HasVerifiedRangeResult(format, "format", 1);
            var clearVerified = HasVerifiedRangeResult(clear, "clear", 2);
            var tableVerified = HasVerifiedRangeResult(table, "table", 4);
            var chartVerified = HasVerifiedRangeResult(chart, "chart", 4);
            var autofitVerified = HasVerifiedAutofitResult(autofit, 5);
            var oversizedMutationRejected =
                IsRejectedWithCode(() => ExecuteSmokeTool(host, "write_values", """{"worksheet":null,"address":"A1:A5001","values":[[1]]}"""), "MODIFY_RANGE_TOO_LARGE") &&
                IsRejectedWithCode(() => ExecuteSmokeTool(host, "format_range", """{"worksheet":null,"address":"A1:A5001","bold":true}"""), "MODIFY_RANGE_TOO_LARGE") &&
                IsRejectedWithCode(() => ExecuteSmokeTool(host, "clear_range", """{"worksheet":null,"address":"A1:A5001","applyTo":"Contents"}"""), "MODIFY_RANGE_TOO_LARGE") &&
                IsRejectedWithCode(() => ExecuteSmokeTool(host, "sort_range", """{"worksheet":null,"address":"A1:A5001","keyColumn":1,"direction":"Ascending","hasHeaders":false}"""), "MODIFY_RANGE_TOO_LARGE") &&
                IsRejectedWithCode(() => ExecuteSmokeTool(host, "create_table", """{"worksheet":null,"address":"A1:A5001","hasHeaders":false,"name":null,"style":null}"""), "MODIFY_RANGE_TOO_LARGE") &&
                IsRejectedWithCode(() => ExecuteSmokeTool(host, "create_chart", """{"worksheet":null,"sourceAddress":"A1:A5001","chartType":"Line","seriesBy":"Auto","title":null,"positionAddress":null}"""), "MODIFY_RANGE_TOO_LARGE");
            var oversizedAutofitRejected = IsRejectedWithCode(
                () => ExecuteSmokeTool(host, "autofit_range", """{"worksheet":null,"address":"1:5001","columns":false,"rows":true}"""),
                "AUTOFIT_TARGET_TOO_LARGE");

            if (!writeVerified || !formulaVerified || !formatVerified || !clearVerified || !tableVerified || !chartVerified ||
                !autofitVerified || !oversizedMutationRejected || !oversizedAutofitRejected)
            {
                var failedChecks = new[]
                {
                    (Name: "write", Passed: writeVerified),
                    (Name: "formulas", Passed: formulaVerified),
                    (Name: "format", Passed: formatVerified),
                    (Name: "clear", Passed: clearVerified),
                    (Name: "table", Passed: tableVerified),
                    (Name: "chart", Passed: chartVerified),
                    (Name: "autofit", Passed: autofitVerified),
                    (Name: "oversized-mutation", Passed: oversizedMutationRejected),
                    (Name: "oversized-autofit", Passed: oversizedAutofitRejected),
                }
                    .Where(check => !check.Passed)
                    .Select(check => check.Name);
                throw new InvalidOperationException($"工作簿操作策略 smoke 检查失败：{string.Join("、", failedChecks)}。");
            }

            return new
            {
                ok = true,
                writeVerified,
                formulaVerified,
                formatVerified,
                clearVerified,
                tableVerified,
                chartVerified,
                autofitVerified,
                oversizedMutationRejected,
                oversizedAutofitRejected,
            };
        }
        finally
        {
            DeleteSmokeChart(host, chartName);
            UnlistSmokeTable(host, tableName);
        }
    }

    private static bool HasVerifiedRangeResult(object result, string kind, int cellCount)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(result, LegacyProtocol.JsonOptions));
        var root = document.RootElement;
        return root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True &&
            root.TryGetProperty("impact", out var impact) && impact.TryGetProperty("cellCount", out var actualCellCount) &&
            actualCellCount.TryGetInt32(out var value) && value == cellCount &&
            root.TryGetProperty("verification", out var verification) &&
            verification.TryGetProperty("kind", out var actualKind) && string.Equals(actualKind.GetString(), kind, StringComparison.Ordinal) &&
            verification.TryGetProperty("matches", out var matches) && matches.ValueKind == JsonValueKind.True;
    }

    private static bool HasVerifiedAutofitResult(object result, int dimensionCount)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(result, LegacyProtocol.JsonOptions));
        var root = document.RootElement;
        return root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True &&
            root.TryGetProperty("impact", out var impact) && impact.TryGetProperty("dimensionCount", out var actualDimensionCount) &&
            actualDimensionCount.TryGetInt32(out var value) && value == dimensionCount &&
            root.TryGetProperty("verification", out var verification) &&
            verification.TryGetProperty("kind", out var kind) && string.Equals(kind.GetString(), "autofit", StringComparison.Ordinal) &&
            verification.TryGetProperty("matches", out var matches) && matches.ValueKind == JsonValueKind.True;
    }

    private static int ReadVerificationInt32(object result, string property)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(result, LegacyProtocol.JsonOptions));
        return document.RootElement.GetProperty("verification").GetProperty(property).GetInt32();
    }

    private static string ReadResultString(object result, string property)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(result, LegacyProtocol.JsonOptions));
        return document.RootElement.GetProperty(property).GetString() ?? string.Empty;
    }

    private static bool IsRejectedWithCode(Func<object> execute, string code)
    {
        try
        {
            execute();
            return false;
        }
        catch (LegacyWorkbookException error) when (error.Code == code)
        {
            return true;
        }
    }

    private static void DeleteSmokeChart(LegacyWorkbookHost host, string chartName)
    {
        if (chartName.Length == 0) return;
        dynamic? worksheet = null;
        dynamic? chartObjects = null;
        dynamic? chartObject = null;
        try
        {
            worksheet = host.GetActiveWorksheet();
            chartObjects = worksheet.ChartObjects();
            chartObject = chartObjects[chartName];
            chartObject.Delete();
        }
        catch (Exception error) when (error is COMException or RuntimeBinderException)
        {
            // The chart may not have been created if a preceding smoke assertion failed.
        }
        finally
        {
            ReleaseCom((object?)chartObject);
            ReleaseCom((object?)chartObjects);
            ReleaseCom((object?)worksheet);
        }
    }

    private static object VerifyTableRollback(LegacyWorkbookHost host)
    {
        const string sourceAddress = "G2:H3";
        ExecuteSmokeTool(host, "write_values", """{"worksheet":null,"address":"G2:H3","values":[[1,2],[3,4]]}""");
        ExecuteSmokeTool(host, "set_number_format", """{"worksheet":null,"address":"G2:H3","formatCode":"0.00"}""");
        var sourceBefore = JsonSerializer.Serialize(
            ExecuteSmokeTool(host, "read_range", """{"worksheet":null,"address":"G2:H3"}"""),
            LegacyProtocol.JsonOptions);
        var tableCountBefore = CountActiveSheetTables(host);
        var tableName = $"ChatExcelSmoke{Guid.NewGuid():N}";

        try
        {
            ExecuteSmokeTool(host, "write_values", """{"worksheet":null,"address":"J2:K3","values":[[5,6],[7,8]]}""");
            ExecuteSmokeTool(host, "create_table", JsonSerializer.Serialize(new
            {
                worksheet = (string?)null,
                address = "J2:K3",
                hasHeaders = false,
                name = tableName,
                style = (string?)null,
            }, LegacyProtocol.JsonOptions));

            var duplicateNameRejected = false;
            try
            {
                ExecuteSmokeTool(host, "create_table", JsonSerializer.Serialize(new
                {
                    worksheet = (string?)null,
                    address = sourceAddress,
                    hasHeaders = false,
                    name = tableName,
                    style = (string?)null,
                }, LegacyProtocol.JsonOptions));
            }
            catch (LegacyWorkbookException)
            {
                duplicateNameRejected = true;
            }

            var sourceAfter = JsonSerializer.Serialize(
                ExecuteSmokeTool(host, "read_range", """{"worksheet":null,"address":"G2:H3"}"""),
                LegacyProtocol.JsonOptions);
            var sourcePreserved = string.Equals(sourceBefore, sourceAfter, StringComparison.Ordinal);
            var failedTableRemoved = CountActiveSheetTables(host) == tableCountBefore + 1;
            if (!duplicateNameRejected || !sourcePreserved || !failedTableRemoved)
            {
                throw new InvalidOperationException("表格回滚 smoke 检查失败。");
            }

            return new { ok = true, duplicateNameRejected, sourcePreserved, failedTableRemoved };
        }
        finally
        {
            UnlistSmokeTable(host, tableName);
        }
    }

    private static int CountActiveSheetTables(LegacyWorkbookHost host)
    {
        dynamic? worksheet = null;
        dynamic? listObjects = null;
        try
        {
            worksheet = host.GetActiveWorksheet();
            listObjects = worksheet.ListObjects;
            return Convert.ToInt32(listObjects.Count);
        }
        finally
        {
            ReleaseCom((object?)listObjects);
            ReleaseCom((object?)worksheet);
        }
    }

    private static void UnlistSmokeTable(LegacyWorkbookHost host, string tableName)
    {
        dynamic? worksheet = null;
        dynamic? listObjects = null;
        dynamic? table = null;
        try
        {
            worksheet = host.GetActiveWorksheet();
            listObjects = worksheet.ListObjects;
            table = listObjects[tableName];
            table.Unlist();
        }
        catch (Exception error) when (error is COMException or RuntimeBinderException)
        {
            // The table may not have been created if a preceding smoke assertion failed.
        }
        finally
        {
            ReleaseCom((object?)table);
            ReleaseCom((object?)listObjects);
            ReleaseCom((object?)worksheet);
        }
    }

    private static object VerifyCancelledCloseKeepsHostUsable(LegacyWorkbookHost host)
    {
        if (host.workbook is null) throw new InvalidOperationException("原生 smoke 工作簿不可用。");

        var cancel = true;
        host.OnWorkbookBeforeClose((object)host.workbook, ref cancel);
        var state = host.HandlePipeRequest(ParseRequest("""{"action":"state"}"""));
        using var stateDocument = JsonDocument.Parse(JsonSerializer.Serialize(state, LegacyProtocol.JsonOptions));
        var hostStillUsable = !host.workbookClosed &&
            stateDocument.RootElement.TryGetProperty("ok", out var ok) &&
            ok.ValueKind == JsonValueKind.True;
        if (!hostStillUsable)
        {
            throw new InvalidOperationException("取消关闭后原生宿主不可用。");
        }

        return new { ok = true, cancel, hostStillUsable };
    }

    private static void CloseSmokeExcel(LegacyWorkbookHost host)
    {
        host.workbookClosed = true;
        host.workbookClosePending = false;
        try { if (host.workbook is not null) host.workbook.Close(SaveChanges: false); } catch { }
        try { if (host.excel is not null) host.excel.Quit(); } catch { }
    }

    private static JsonElement ParseRequest(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private sealed class WindowOwner(IntPtr handle) : NativeWindow, IWin32Window
    {
        public IntPtr HandleValue { get; } = handle;
        IntPtr IWin32Window.Handle => HandleValue;
        public void AssignTo(Form form) => NativeMethods.SetWindowLongPtr(form.Handle, -8, HandleValue);
    }

    private delegate void SheetChangeEventHandler(object sheet, object target);
    private delegate void SheetActivateEventHandler(object sheet);
    private delegate void WorkbookBeforeCloseEventHandler(object workbook, ref bool cancel);

    private static class NativeMethods
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetWindowRect(IntPtr handle, out Rect rectangle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsWindow(IntPtr handle);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
        internal static extern IntPtr SetWindowLongPtr(IntPtr handle, int index, IntPtr value);
    }
}

internal sealed class LegacyWorkbookException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
