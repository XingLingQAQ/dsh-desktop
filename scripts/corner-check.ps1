# One-shot: launch dev, capture splash window + corner pixels, dump main window region.
$ErrorActionPreference = "Stop"
$outFile = "D:\Project\DS\dsh-desktop\corner-report.txt"
function Log($msg) { Add-Content -Path $outFile -Value $msg }

Set-Content -Path $outFile -Value "corner report $(Get-Date -Format o)"

# clean our processes
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*dsh-desktop*" }
foreach ($pr in $procs) { Stop-Process -Id $pr.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process dsh-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "D:\Project\DS*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CornerCap {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hWnd, IntPtr rgn);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static string[] List(uint targetPid) {
        var list = new System.Collections.Generic.List<string>();
        EnumWindows((h, l) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == targetPid) {
                var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
                if (sb.Length == 0) return true;
                RECT r; GetWindowRect(h, out r);
                list.Add(string.Format("hwnd={0} iconic={1} rect={2},{3}-{4},{5} title='{6}'", h, IsIconic(h), r.Left, r.Top, r.Right, r.Bottom, sb.ToString()));
            }
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
}
"@

$env:NODE_ENV = "development"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
$env:DSH_SPLASH_HOLD_MS = "60000"
$dev = Start-Process -FilePath "npm.cmd" -ArgumentList "run","tauri","dev" -WorkingDirectory "D:\Project\DS\dsh-desktop" -RedirectStandardOutput "D:\Project\DS\dsh-desktop\tauri-dev.log" -RedirectStandardError "D:\Project\DS\dsh-desktop\tauri-dev-err.log" -PassThru -WindowStyle Hidden
Log "dev started pid=$($dev.Id)"

# wait for app
$app = $null
for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    $app = Get-Process dsh-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "D:\Project\DS*" } | Select-Object -First 1
    if ($app) { break }
}
if (-not $app) { Log "APP NEVER STARTED"; exit 1 }
Log "app pid=$($app.Id)"

# wait for splash window (480x430 small one)
$splash = [IntPtr]::Zero
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 300
    $wins = [CornerCap]::List([uint32]$app.Id)
    foreach ($w in $wins) {
        if ($w -match "title='DeepSeek Harness'" -and $w -notmatch "Desktop") {
            if ($w -match "rect=(-?\d+),(-?\d+)-(-?\d+),(-?\d+)") {
                $wdt = [int]$matches[3] - [int]$matches[1]
                if ($wdt -gt 300 -and $wdt -lt 600) {
                    if ($w -match "hwnd=(\d+)") { $splash = [IntPtr][long]$matches[1] }
                    Log "splash found: $w"
                    break
                }
            }
        }
    }
    if ($splash -ne [IntPtr]::Zero) { break }
}
if ($splash -eq [IntPtr]::Zero) { Log "SPLASH NOT FOUND" } else {
    $r = New-Object CornerCap+RECT
    [CornerCap]::GetWindowRect($splash, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $bmp.Save("D:\Project\DS\dsh-desktop\m1-splash-corner.png", [System.Drawing.Imaging.ImageFormat]::Png)
    foreach ($pt in @(@(3,3), @(15,15), @(25,25), @(40,40), @([int]($w/2), [int]($h/2)), @($w-3,3), @(3,$h-3))) {
        $c = $bmp.GetPixel($pt[0], $pt[1])
        Log "splash pixel($($pt[0]),$($pt[1])) = rgb($($c.R),$($c.G),$($c.B))"
    }
    $g.Dispose(); $bmp.Dispose()
}

# main window region check
$main = $null
$wins2 = [CornerCap]::List([uint32]$app.Id)
foreach ($w in $wins2) { if ($w -match "title='DeepSeek Harness Desktop'") { if ($w -match "hwnd=(\d+)") { $main = [IntPtr][long]$matches[1] }; Log "main: $w" } }
if ($main) {
    $rgn = [CornerCap]::CreateRectRgn(0, 0, 1, 1)
    $rt = [CornerCap]::GetWindowRgn($main, $rgn)
    Log "main GetWindowRgn = $rt (0=none,1=simple,2=complex)"
}
Log "REPORT DONE"
