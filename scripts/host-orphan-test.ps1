# Verify the host dies with the shell, even when the shell is force-killed.
#
# The shell already kills the host on a clean exit, so testing that proves
# nothing. The interesting case is the rude one: Stop-Process -Force skips the
# exit handler entirely, which is exactly how twelve orphaned hosts accumulated
# and left sessions un-sendable. The fix is a kill-on-close job object, so the
# kernel should clean up where the application's own code cannot run.
$app = Get-Process dsh-desktop -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $app) { Write-Output "app not running"; exit 1 }
$appPid = $app.Id
Write-Output "shell pid: $appPid"

# The host is a child of the shell, so identify it by parent rather than by name:
# other DSH hosts on this machine (the one running the agent, for one) must not be
# touched, and a name match would catch them too.
$hostProc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ParentProcessId -eq $appPid }
if (-not $hostProc) { Write-Output "no host child found under the shell"; exit 1 }
Write-Output "host pid : $($hostProc.ProcessId)"
$hostPid = $hostProc.ProcessId

Write-Output ""
Write-Output "force-killing the shell (no exit handler runs)"
Stop-Process -Id $appPid -Force
Start-Sleep -Seconds 5

$still = Get-Process -Id $hostPid -ErrorAction SilentlyContinue
if ($still) {
  Write-Output "RESULT: host $hostPid SURVIVED -- job object did not work"
} else {
  Write-Output "RESULT: host $hostPid is gone -- kill-on-close worked"
}
$leftover = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ParentProcessId -eq $appPid }
Write-Output "children still under the dead shell: $($leftover.Count)"
