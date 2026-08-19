# Capture the splash window while it is alive (it closes ~4s after app start).
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class SplashCap {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static IntPtr Find(uint targetPid, string titlePart) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == targetPid) {
                var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
                if (sb.ToString().Contains(titlePart)) { found = h; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

function Find-MyApp {
    return Get-Process dsh-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "D:\Project\DS*" } | Select-Object -First 1
}

# wait for the app
$app = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $app = Find-MyApp
    if ($app) { break }
}
if (-not $app) { Write-Output "app never started"; exit 1 }

# wait for the splash window (title 'DeepSeek Harness', NOT 'Desktop')
$splash = [IntPtr]::Zero
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 200
    $splash = [SplashCap]::Find([uint32]$app.Id, "DeepSeek Harness")
    # distinguish from main window: splash is small
    if ($splash -ne [IntPtr]::Zero) {
        $r = New-Object SplashCap+RECT
        [SplashCap]::GetWindowRect($splash, [ref]$r) | Out-Null
        if (($r.Right - $r.Left) -lt 600) { break }
        $splash = [IntPtr]::Zero
    }
}
if ($splash -eq [IntPtr]::Zero) { Write-Output "splash window not found in time"; exit 1 }

$r = New-Object SplashCap+RECT
[SplashCap]::GetWindowRect($splash, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
Write-Output "splash window: ${w}x${h} at ($($r.Left),$($r.Top))"

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
$bmp.Save("D:\Project\DS\dsh-desktop\m1-splash-check.png", [System.Drawing.Imaging.ImageFormat]::Png)

# scan: card should occupy most of the window with transparent margins
$points = @(
    @(4, 4),            # top-left corner: transparent (desktop shows)
    @($w - 5, 4),       # top-right corner: transparent
    @(4, $h - 5),       # bottom-left: transparent
    @($w - 5, $h - 5),  # bottom-right: transparent
    @([int]($w / 2), [int]($h / 2))  # center: card content
)
foreach ($pt in $points) {
    $c = $bmp.GetPixel($pt[0], $pt[1])
    Write-Output "pixel($($pt[0]),$($pt[1])) = rgb($($c.R),$($c.G),$($c.B))"
}
$g.Dispose(); $bmp.Dispose()
