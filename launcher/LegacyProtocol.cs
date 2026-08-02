using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ChatExcelLauncher;

internal static class LegacyProtocol
{
    public const int MaxMessageBytes = 512 * 1024;
    private const string PipePrefix = "ChatExcel-Legacy-";

    public static string CreateSessionId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();

    public static bool IsValidSessionId(string? value)
    {
        if (value?.Length != 48) return false;
        return value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    }

    public static string PipeName(string sessionId)
    {
        if (!IsValidSessionId(sessionId)) throw new ArgumentException("原生会话标识无效。", nameof(sessionId));
        return PipePrefix + sessionId;
    }

    public static async Task<JsonDocument> ReadMessageAsync(Stream stream, CancellationToken cancellationToken)
    {
        var lengthBuffer = new byte[4];
        await ReadExactlyAsync(stream, lengthBuffer, cancellationToken);
        var length = BitConverter.ToInt32(lengthBuffer);
        if (length is <= 0 or > MaxMessageBytes)
        {
            throw new InvalidDataException("原生桥消息尺寸无效。");
        }

        var payload = new byte[length];
        await ReadExactlyAsync(stream, payload, cancellationToken);
        return JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = 32 });
    }

    public static async Task WriteMessageAsync(Stream stream, object value, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions);
        if (payload.Length > MaxMessageBytes) throw new InvalidDataException("原生桥响应超过尺寸限制。");
        await stream.WriteAsync(BitConverter.GetBytes(payload.Length), cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer[offset..], cancellationToken);
            if (read == 0) throw new EndOfStreamException("原生桥连接提前关闭。");
            offset += read;
        }
    }
}

internal sealed class LegacyPipeServer : IDisposable
{
    private readonly string pipeName;
    private readonly Func<JsonElement, object> handler;
    private readonly CancellationTokenSource cancellation = new();
    private Task? loop;
    private bool disposed;

    public LegacyPipeServer(string sessionId, Func<JsonElement, object> handler)
    {
        pipeName = LegacyProtocol.PipeName(sessionId);
        this.handler = handler;
    }

    public void Start()
    {
        if (loop is not null) throw new InvalidOperationException("原生桥已启动。");
        loop = Task.Run(RunAsync);
    }

    private async Task RunAsync()
    {
        while (!cancellation.IsCancellationRequested)
        {
            await using var pipe = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await pipe.WaitForConnectionAsync(cancellation.Token);
                using var message = await LegacyProtocol.ReadMessageAsync(pipe, cancellation.Token);
                object response;
                try
                {
                    response = handler(message.RootElement.Clone());
                }
                catch (LegacyWorkbookException error)
                {
                    response = new { ok = false, error = new { code = error.Code, message = error.Message } };
                }
                catch (Exception)
                {
                    response = new { ok = false, error = new { code = "NATIVE_EXCEL_ERROR", message = "Excel 原生操作失败。" } };
                }
                try
                {
                    await LegacyProtocol.WriteMessageAsync(pipe, response, cancellation.Token);
                }
                catch (InvalidDataException)
                {
                    await LegacyProtocol.WriteMessageAsync(
                        pipe,
                        new { ok = false, error = new { code = "NATIVE_RESPONSE_TOO_LARGE", message = "Excel 原生结果超过传输限制，请缩小读取范围。" } },
                        cancellation.Token);
                }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                break;
            }
            catch (IOException)
            {
                // The caller can disconnect at any point. The next request gets a new pipe instance.
            }
            catch (JsonException)
            {
                if (pipe.IsConnected)
                {
                    await LegacyProtocol.WriteMessageAsync(
                        pipe,
                        new { ok = false, error = new { code = "NATIVE_REQUEST_INVALID", message = "原生桥请求不是有效 JSON。" } },
                        cancellation.Token);
                }
            }
            catch (InvalidDataException)
            {
                if (pipe.IsConnected)
                {
                    await LegacyProtocol.WriteMessageAsync(
                        pipe,
                        new { ok = false, error = new { code = "NATIVE_REQUEST_INVALID", message = "原生桥请求尺寸无效。" } },
                        cancellation.Token);
                }
            }
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        cancellation.Cancel();
        try { loop?.Wait(TimeSpan.FromSeconds(2)); } catch { }
        cancellation.Dispose();
    }
}
