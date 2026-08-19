# CDP debug helper: attach to the app's WebView2 pages and dump console errors + DOM state.
param(
    [string]$DebugPort = "9222"
)

$ErrorActionPreference = "Stop"

function Send-Cdp([System.Net.WebSockets.ClientWebSocket]$ws, [int]$id, [string]$method, $params) {
    $msg = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
    $seg = [System.ArraySegment[byte]]::new($bytes)
    $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 65536
    $sb = New-Object System.Text.StringBuilder
    do {
        $seg2 = [System.ArraySegment[byte]]::new($buffer)
        $res = $ws.ReceiveAsync($seg2, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
    } while (-not $res.EndOfMessage)
    return $sb.ToString() | ConvertFrom-Json
}

$pages = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 10
foreach ($page in $pages) {
    if ($page.type -ne "page") { continue }
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    [void](Send-Cdp $ws 1 "Runtime.enable" @{})
    [void](Send-Cdp $ws 2 "Log.enable" @{})
    $expr = "JSON.stringify({url: location.href, bodyBg: getComputedStyle(document.body).backgroundColor, rootHtml: (document.getElementById('root')?.innerHTML || '').slice(0,300), scripts: document.scripts.length, links: document.styleSheets.length})"
    $res = Send-Cdp $ws 3 "Runtime.evaluate" @{ expression = $expr; returnByValue = $true }
    Write-Output "=== page: $($page.url) ==="
    if ($res.result.result.value) { Write-Output $res.result.result.value }
    else { Write-Output "eval error: $($res.result.exceptionDetails.exception.description)" }
    $ws.Dispose()
}
