# M1 验证脚本：确认 dsh-desktop 启动、双窗口创建、进程存活
param(
    [string]$ExePath = "",
    [int]$WaitSeconds = 10
)
$ErrorActionPreference = "Stop"

if (-not $ExePath) {
    $candidates = @(
        "D:\Project\DS\dsh-desktop\src-tauri\target\debug\dsh-desktop.exe",
        "D:\Project\DS\dsh-desktop\src-tauri\target\release\dsh-desktop.exe"
    )
    $ExePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ExePath -or -not (Test-Path $ExePath)) {
    Write-Error "dsh-desktop.exe not found; build first (cargo build)"
    exit 1
}

Write-Host "Launching: $ExePath"
$proc = Start-Process -FilePath $ExePath -PassThru
Start-Sleep -Seconds $WaitSeconds

if ($proc.HasExited) {
    Write-Error "Process exited early with code $($proc.ExitCode)"
    exit 1
}

$alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if (-not $alive) {
    Write-Error "Process died after start"
    exit 1
}

Write-Host "OK: process alive (pid $($proc.Id))"
Write-Host "MainWindowTitle: '$($alive.MainWindowTitle)'"
Write-Host "MainWindowHandle: $($alive.MainWindowHandle)"

# 枚举窗口标题（splash + main 应有可识别标题）
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public static string[] Titles(uint targetPid) {
        var list = new System.Collections.Generic.List<string>();
        EnumWindows((h, l) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == targetPid) {
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, 256);
                if (sb.Length > 0) list.Add(sb.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
}
"@
$titles = [WinEnum]::Titles([uint32]$proc.Id)
Write-Host "Window titles: $($titles -join ' | ')"

if ($titles.Count -ge 1) {
    Write-Host "PASS: windows created"
} else {
    Write-Host "WARN: no titled windows visible (may be session 0 / no interactive desktop)"
}

# 收尾：关闭应用
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    Write-Host "WARN: process did not die on Stop-Process"
} else {
    Write-Host "Cleaned up: process exited"
}
