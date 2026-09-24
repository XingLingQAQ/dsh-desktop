# Report the pet window, the tray menu and the work area together.
#
# One script because their relationship is the thing being checked: the menu has
# to stay inside the work area, and whether that means opening below the pet or
# above it depends on where the pet is.
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, out RECT r, uint f);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$proc = Get-Process dsh-desktop -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output "app not running"; exit 1 }
$appPid = $proc.Id

$rows = @()
$cb = [W+EnumProc]{
  param($h, $p)
  $pid_ = 0
  [W]::GetWindowThreadProcessId($h, [ref]$pid_) | Out-Null
  if ($pid_ -eq $script:appPid) {
    $sb = New-Object System.Text.StringBuilder 512
    [W]::GetWindowText($h, $sb, 512) | Out-Null
    $r = New-Object W+RECT
    [W]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.R - $r.L; $hh = $r.B - $r.T
    # The pet and the tray menu are the only small windows this shell makes.
    if ($w -gt 40 -and $w -le 260 -and $hh -ge 100) {
      $script:rows += [pscustomobject]@{
        title = $sb.ToString(); visible = [W]::IsWindowVisible($h)
        left = $r.L; top = $r.T; right = $r.R; bottom = $r.B
        width = $w; height = $hh
      }
    }
  }
  return $true
}
[W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

$work = New-Object W+RECT
[W]::SystemParametersInfo(0x0030, 0, [ref]$work, 0) | Out-Null
Write-Output ("work area: {0},{1} - {2},{3}" -f $work.L, $work.T, $work.R, $work.B)

foreach ($f in $rows) {
  $tag = if ($f.height -lt 180) { 'pet ' } else { 'menu' }
  Write-Output ("{0} '{1}' visible={2} rect={3},{4} {5}x{6}" -f `
    $tag, $f.title, $f.visible, $f.left, $f.top, $f.width, $f.height)
  $outTop = [Math]::Max(0, $work.T - $f.top)
  $outBottom = [Math]::Max(0, $f.bottom - $work.B)
  $outLeft = [Math]::Max(0, $work.L - $f.left)
  $outRight = [Math]::Max(0, $f.right - $work.R)
  Write-Output ("      outside work area: top={0} bottom={1} left={2} right={3}" -f `
    $outTop, $outBottom, $outLeft, $outRight)
}
