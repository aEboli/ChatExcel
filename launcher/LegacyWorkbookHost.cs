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
    private const int SheetActivateDispId = 0x619;
    private const int SheetChangeDispId = 0x61c;
    private const int WorkbookBeforeCloseDispId = 0x622;
    private static readonly Guid AppEventsIid = new("00024413-0000-0000-C000-000000000046");
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
    private int revision;
    private int activeSheetRevision;
    private IntPtr excelWindow;
    private bool released;

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
        try
        {
            var excelType = Type.GetTypeFromProgID("Excel.Application", throwOnError: true)!;
            excel = Activator.CreateInstance(excelType)
                ?? throw new InvalidOperationException("无法创建 Excel.Application COM 实例。");
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
                ReleaseCom(workbooks);
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
            ReleaseExcelReferences();
            throw new LauncherInputException($"无法用 Microsoft Excel 打开该 .xls 工作簿：{SafeComMessage(error)}");
        }
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
            MessageBox.Show(
                this,
                $"无法启动 ChatExcel 原生窗格。请确认已安装 Microsoft Edge WebView2 Runtime。\n\n{error.Message}",
                "ChatExcel Launcher",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
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
            ReleaseCom(worksheet);
        }
    }

    private object Undo()
    {
        try
        {
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
                try { names.Add(worksheet.Name); } finally { ReleaseCom(worksheet); }
            }
            active = GetActiveWorksheet();
            selection = GetSelectedRange();
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
                        mode = IsExcelRange(excel!.Selection) ? "range" : "activeCell",
                    },
                },
            };
        }
        finally
        {
            ReleaseCom(selection);
            ReleaseCom(active);
            ReleaseCom(worksheets);
        }
    }

    private object GetSelection()
    {
        var range = GetSelectedRange();
        try { return ReadRangeObject(range); } finally { ReleaseCom(range); }
    }

    private object ReadRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        try { return ReadRangeObject(range); } finally { ReleaseCom(range); }
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
                numberFormat = ToRows(range.NumberFormat, rowCount, columnCount),
            };
        }
        finally
        {
            ReleaseCom(worksheet);
        }
    }

    private object WriteMatrix(JsonElement arguments, string property, bool formulas)
    {
        var range = GetRange(arguments);
        try
        {
            var matrix = RequiredMatrix(arguments, property);
            var rowCount = range.Rows.Count;
            var columnCount = range.Columns.Count;
            if (matrix.GetLength(0) != rowCount || matrix.GetLength(1) != columnCount)
            {
                throw new LegacyWorkbookException("MATRIX_SIZE_MISMATCH", $"二维数组尺寸与目标范围不一致；目标为 {rowCount} 行 x {columnCount} 列。");
            }
            if (formulas) range.Formula = matrix; else range.Value2 = matrix;
            return RangeResult(range, new { rowCount, columnCount });
        }
        finally
        {
            ReleaseCom(range);
        }
    }

    private object FormatRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        dynamic? interior = null;
        dynamic? font = null;
        try
        {
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
            return RangeResult(range);
        }
        finally
        {
            ReleaseCom(font);
            ReleaseCom(interior);
            ReleaseCom(range);
        }
    }

    private object SetNumberFormat(JsonElement arguments)
    {
        var range = GetRange(arguments);
        try
        {
            range.NumberFormat = RequiredString(arguments, "formatCode");
            return RangeResult(range);
        }
        finally { ReleaseCom(range); }
    }

    private object AutofitRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        dynamic? entireColumns = null;
        dynamic? entireRows = null;
        try
        {
            if (RequiredBoolean(arguments, "columns"))
            {
                entireColumns = range.EntireColumn;
                entireColumns.AutoFit();
            }
            if (RequiredBoolean(arguments, "rows"))
            {
                entireRows = range.EntireRow;
                entireRows.AutoFit();
            }
            return RangeResult(range);
        }
        finally
        {
            ReleaseCom(entireRows);
            ReleaseCom(entireColumns);
            ReleaseCom(range);
        }
    }

    private object ClearRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        try
        {
            switch (RequiredString(arguments, "applyTo"))
            {
                case "All": range.Clear(); break;
                case "Contents": range.ClearContents(); break;
                case "Formats": range.ClearFormats(); break;
                default: throw new LegacyWorkbookException("TOOL_ARGUMENT_ENUM", "清除模式无效。");
            }
            return RangeResult(range);
        }
        finally { ReleaseCom(range); }
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
            ReleaseCom(worksheet);
            ReleaseCom(worksheets);
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
        finally { ReleaseCom(worksheet); }
    }

    private object CreateTable(JsonElement arguments)
    {
        var range = GetRange(arguments);
        dynamic worksheet = range.Worksheet;
        dynamic listObjects = worksheet.ListObjects;
        dynamic? table = null;
        try
        {
            table = listObjects.Add(
                XlSrcRange,
                range,
                Type.Missing,
                RequiredBoolean(arguments, "hasHeaders") ? XlYes : XlNo,
                Type.Missing);
            try
            {
                if (OptionalString(arguments, "name") is { } name) table.Name = name;
                if (OptionalString(arguments, "style") is { } style) table.TableStyle = style;
            }
            catch
            {
                table.Delete();
                throw;
            }
            return new
            {
                ok = true,
                target = $"{worksheet.Name}!{RangeAddress(range)}",
                worksheet = worksheet.Name,
                table = table.Name,
                style = OptionalString(arguments, "style"),
            };
        }
        finally
        {
            ReleaseCom(table);
            ReleaseCom(listObjects);
            ReleaseCom(worksheet);
            ReleaseCom(range);
        }
    }

    private object CreateChart(JsonElement arguments)
    {
        var range = GetRange(arguments, "sourceAddress");
        dynamic worksheet = range.Worksheet;
        dynamic? chartObjects = null;
        dynamic? chartObject = null;
        dynamic? chart = null;
        dynamic? position = null;
        try
        {
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
            return new
            {
                ok = true,
                target = $"{worksheet.Name}!{RangeAddress(range)}",
                worksheet = worksheet.Name,
                chart = chartObject.Name,
                chartType = RequiredString(arguments, "chartType"),
            };
        }
        finally
        {
            ReleaseCom(position);
            ReleaseCom(chart);
            ReleaseCom(chartObject);
            ReleaseCom(chartObjects);
            ReleaseCom(worksheet);
            ReleaseCom(range);
        }
    }

    private object SortRange(JsonElement arguments)
    {
        var range = GetRange(arguments);
        dynamic? key = null;
        try
        {
            var keyColumn = RequiredInt32(arguments, "keyColumn");
            if (keyColumn > range.Columns.Count)
            {
                throw new LegacyWorkbookException("SORT_KEY_OUT_OF_RANGE", $"排序列 {keyColumn} 超出目标范围的 {range.Columns.Count} 列。");
            }
            key = range.Columns[keyColumn];
            range.Sort(
                Key1: key,
                Order1: RequiredString(arguments, "direction") == "Ascending" ? XlAscending : XlDescending,
                Header: RequiredBoolean(arguments, "hasHeaders") ? XlYes : XlNo,
                Orientation: XlSortRows);
            return RangeResult(range, new { keyColumn, direction = RequiredString(arguments, "direction") });
        }
        finally
        {
            ReleaseCom(key);
            ReleaseCom(range);
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
        finally { ReleaseCom(worksheet); }
    }

    private dynamic GetSelectedRange()
    {
        dynamic selection = excel!.Selection;
        if (IsExcelRange(selection)) return selection;
        ReleaseCom(selection);
        return excel.ActiveCell;
    }

    private dynamic GetActiveWorksheet()
    {
        dynamic worksheet = workbook!.ActiveSheet;
        if (!IsExcelWorksheet(worksheet))
        {
            ReleaseCom(worksheet);
            throw new LegacyWorkbookException("WORKSHEET_UNAVAILABLE", "当前活动对象不是工作表。");
        }
        return worksheet;
    }

    private dynamic GetWorksheet(string name)
    {
        dynamic worksheets = workbook!.Worksheets;
        try { return worksheets[name]; }
        catch (COMException) { throw new LegacyWorkbookException("WORKSHEET_NOT_FOUND", $"找不到工作表“{name}”。"); }
        finally { ReleaseCom(worksheets); }
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
            ReleaseCom(worksheet);
            ReleaseCom(worksheets);
        }
    }

    private object RangeResult(dynamic range, object? details = null)
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
            return result;
        }
        finally { ReleaseCom(worksheet); }
    }

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
        if (!suppressEvents) revision += 1;
    }

    private void OnSheetActivate(object sheet)
    {
        activeSheetRevision += 1;
    }

    private void OnWorkbookBeforeClose(object closingWorkbook, ref bool cancel)
    {
        dynamic closing = closingWorkbook;
        try
        {
            if (workbook is null || !string.Equals((string)closing.FullName, (string)workbook.FullName, StringComparison.OrdinalIgnoreCase)) return;
            workbookClosed = true;
            if (IsHandleCreated) BeginInvoke(Close);
        }
        catch (COMException)
        {
            workbookClosed = true;
            if (IsHandleCreated) BeginInvoke(Close);
        }
    }

    private void TrackExcelWindow()
    {
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
        ReleaseCom(workbook);
        ReleaseCom(excel);
        workbook = null;
        excel = null;
        GC.Collect();
        GC.WaitForPendingFinalizers();
    }

    private static void ReleaseCom(object? value)
    {
        if (value is not null && Marshal.IsComObject(value))
        {
            try { Marshal.FinalReleaseComObject(value); } catch { }
        }
    }

    private void RemoveComEvent(int dispId, Delegate? handler)
    {
        if (excel is null || handler is null) return;
        try { ComEventsHelper.Remove(excel, AppEventsIid, dispId, handler); } catch { }
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
            ReleaseCom(cells);
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
            var write = host.HandlePipeRequest(ParseRequest(
                """{"action":"execute","name":"write_values","arguments":{"worksheet":null,"address":"B2","values":[["native-xls-ok"]]}}"""));
            var format = host.HandlePipeRequest(ParseRequest(
                """{"action":"execute","name":"format_range","arguments":{"worksheet":null,"address":"B2","fillColor":"#DFF6E8","fontColor":"#107C41","bold":true,"italic":false,"fontSize":11,"horizontalAlignment":"Center","verticalAlignment":"Center","wrapText":false}}"""));
            var read = host.HandlePipeRequest(ParseRequest(
                """{"action":"execute","name":"read_range","arguments":{"worksheet":null,"address":"A1:B2"}}"""));
            host.workbook.Save();
            var formatAfter = (int)host.workbook.FileFormat;
            var fullName = host.workbook.FullName;
            host.workbook.Close(SaveChanges: false);
            host.workbookClosed = true;
            host.excel!.Quit();
            return JsonSerializer.Serialize(new
            {
                ok = true,
                fullName,
                formatBefore,
                formatAfter,
                write,
                format,
                read,
            }, LegacyProtocol.JsonOptions);
        }
        finally
        {
            host.ReleaseHost();
        }
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
