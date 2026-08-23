# One-shot CDP eval helper: run a JS expression in every WebView2 page and print the result.
#
# Prefer -File over -Expression: PowerShell 5.1's Get-Content defaults to the
# system ANSI codepage, so `-Expression (Get-Content probe.js -Raw)` silently
# corrupts any non-ASCII literal in the probe. -File reads UTF-8 explicitly.
param(
    [string]$Expression,
    [string]$File,
    [string]$UrlMatch = "",
    [string]$DebugPort = "9222"
)

$ErrorActionPreference = "Stop"

if ($File) {
    $Expression = [System.IO.File]::ReadAllText((Resolve-Path $File), [System.Text.Encoding]::UTF8)
}
if (-not $Expression) { throw "pass -Expression or -File" }

function Send-Cdp([System.Net.WebSockets.ClientWebSocket]$ws, [int]$id, [string]$method, $params) {
    $msg = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
    $seg = [System.ArraySegment[byte]]::new($bytes)
    [void]$ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 262144
    # CDP interleaves events with command replies; keep reading until the frame
    # carrying our request id arrives.
    for ($attempt = 0; $attempt -lt 200; $attempt++) {
        $sb = New-Object System.Text.StringBuilder
        do {
            $seg2 = [System.ArraySegment[byte]]::new($buffer)
            $res = $ws.ReceiveAsync($seg2, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
            [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
        } while (-not $res.EndOfMessage)
        $parsed = $sb.ToString() | ConvertFrom-Json
        if ($parsed.id -eq $id) { return $parsed }
    }
    throw "no CDP reply for id $id ($method)"
}

$pages = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 10
foreach ($page in $pages) {
    if ($page.type -ne "page") { continue }
    if ($UrlMatch -and ($page.url -notlike "*$UrlMatch*")) { continue }
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    [void]$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    [void](Send-Cdp $ws 1 "Runtime.enable" @{})
    $res = Send-Cdp $ws 2 "Runtime.evaluate" @{ expression = $Expression; returnByValue = $true; awaitPromise = $true }
    Write-Output "=== $($page.url) ==="
    if ($null -ne $res.result.result.value) { Write-Output $res.result.result.value }
    elseif ($res.result.exceptionDetails) { Write-Output "EVAL ERROR: $($res.result.exceptionDetails.exception.description)" }
    else { Write-Output "(undefined)" }
    $ws.Dispose()
}
