# Verify dynamic theme sync: flip DSH page to dark, then read shell variables.
$ErrorActionPreference = "Stop"

function Invoke-Cdp($ws, [int]$id, [string]$method, $params) {
    $msg = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
    [void]$ws.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $buf = New-Object byte[] 131072
    $sb = New-Object System.Text.StringBuilder
    do {
        $r = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
    } while (-not $r.EndOfMessage)
    return $sb.ToString() | ConvertFrom-Json
}

function Get-PageWs($urlPart) {
    $pages = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/list" -TimeoutSec 8
    $pg = $pages | Where-Object { $_.type -eq "page" -and $_.url -like "*$urlPart*" } | Select-Object -First 1
    if (-not $pg) { throw "page not found: $urlPart" }
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    [void]$ws.ConnectAsync([Uri]$pg.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    return $ws
}

function Eval($ws, [string]$expr) {
    $res = Invoke-Cdp $ws 1 "Runtime.evaluate" @{ expression = $expr; returnByValue = $true }
    return $res.result.result.value
}

function Shell-Theme($ws) {
    return Eval $ws "JSON.stringify({theme: document.documentElement.dataset.theme, tb: getComputedStyle(document.documentElement).getPropertyValue('--ds-tb-bg').trim(), brand: getComputedStyle(document.documentElement).getPropertyValue('--ds-brand').trim(), bg: getComputedStyle(document.documentElement).getPropertyValue('--ds-bg-base').trim(), border: getComputedStyle(document.documentElement).getPropertyValue('--ds-border').trim()})"
}

$content = Get-PageWs "127.0.0.1:17890"
$shell = Get-PageWs "localhost:1420/"
$splash = Get-PageWs "localhost:1420/splash.html"

Write-Output "SHELL before:    $(Shell-Theme $shell)"
Write-Output "SPLASH before:   $(Shell-Theme $splash)"

# Flip DSH to dark (as its theme presenter would)
Write-Output "flip to dark..."
[void](Eval $content "document.body.setAttribute('data-ds-dark-theme',''); 'ok'")
Start-Sleep -Seconds 3

Write-Output "SHELL after:     $(Shell-Theme $shell)"
Write-Output "SPLASH after:    $(Shell-Theme $splash)"

# Flip back to light
Write-Output "flip to light..."
[void](Eval $content "document.body.removeAttribute('data-ds-dark-theme'); 'ok'")
Start-Sleep -Seconds 3

Write-Output "SHELL restored:  $(Shell-Theme $shell)"
$content.Dispose(); $shell.Dispose(); $splash.Dispose()
