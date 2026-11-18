param([int]$Seconds = 120, [string]$Out = "$env:TEMP\window-watch.log")
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure/window-watch.ps1 -Seconds 10800 -Out <log>
# Logs every top-level window that is shown (EVENT_OBJECT_SHOW), read only.
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WW {
  public delegate void WinEventProc(IntPtr h, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool PeekMessageW(out MSG m, IntPtr h, uint a, uint b, uint remove);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG m);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }
  public static System.Collections.Concurrent.ConcurrentQueue<string> Q = new System.Collections.Concurrent.ConcurrentQueue<string>();
  public static WinEventProc Cb = (h, ev, hwnd, idObject, idChild, thread, time) => {
    if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
    if (GetAncestor(hwnd, 2) != hwnd) return;
    var c = new StringBuilder(256); GetClassNameW(hwnd, c, 256);
    var t = new StringBuilder(256); GetWindowTextW(hwnd, t, 256);
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    Q.Enqueue(DateTime.Now.ToString("HH:mm:ss.fff") + "\tev=0x" + ev.ToString("x") + "\thwnd=" + hwnd + "\tvisible=" + IsWindowVisible(hwnd) + "\tpid=" + pid + "\tclass=" + c + "\ttitle=" + t);
  };
  public static void Pump() { MSG m; while (PeekMessageW(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessageW(ref m); } }
}
"@
$hook = [WW]::SetWinEventHook(0x8002, 0x8002, [IntPtr]::Zero, [WW]::Cb, 0, 0, 0)
"$(Get-Date -Format 'HH:mm:ss.fff')`twatch start pid=$PID hook=$hook" | Out-File -Append -Encoding utf8 $Out
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  [WW]::Pump()
  $line = $null
  while ([WW]::Q.TryDequeue([ref]$line)) {
    $wpid = [int](($line -split "`t" | Where-Object { $_ -like 'pid=*' }) -replace 'pid=', '')
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$wpid" -ErrorAction SilentlyContinue
    $pp = if ($p) { Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue }
    "$line`tproc=$($p.Name)`tparent=$($p.ParentProcessId) $($pp.Name)`tcmd=$($p.CommandLine)" | Out-File -Append -Encoding utf8 $Out
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='cmd.exe' OR Name='sh.exe' OR Name='bash.exe' OR Name='conhost.exe' OR Name='OpenConsole.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
      $q = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue
      "    running: $($_.ProcessId) $($_.Name) started=$($_.CreationDate.ToString('HH:mm:ss.fff')) parent=$($_.ParentProcessId) $($q.Name) cmd=$($_.CommandLine)" | Out-File -Append -Encoding utf8 $Out
    }
  }
  Start-Sleep -Milliseconds 20
}
[WW]::UnhookWinEvent($hook) | Out-Null
"$(Get-Date -Format 'HH:mm:ss.fff')`twatch end" | Out-File -Append -Encoding utf8 $Out
