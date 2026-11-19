param([int]$Seconds = 900, [string]$Out = "$env:TEMP\title-watch.log", [string]$Process = 'Code')
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure/title-watch.ps1 -Seconds 900 -Out <log>
# Logs, read only, every foreground change (EVENT_SYSTEM_FOREGROUND) and every title change
# (EVENT_OBJECT_NAMECHANGE) of a top-level window of $Process. A title change is logged only when
# the title differs from the last one seen for that window. Each line says whether the window is in
# the foreground at that moment.
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TW {
  public delegate void WinEventProc(IntPtr h, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PeekMessageW(out MSG m, IntPtr h, uint a, uint b, uint remove);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG m);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }
  public static System.Collections.Concurrent.ConcurrentQueue<object[]> Q = new System.Collections.Concurrent.ConcurrentQueue<object[]>();
  public static WinEventProc Cb = (h, ev, hwnd, idObject, idChild, thread, time) => {
    if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
    if (GetAncestor(hwnd, 2) != hwnd) return;
    var t = new StringBuilder(512); GetWindowTextW(hwnd, t, 512);
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    Q.Enqueue(new object[] { DateTime.Now.ToString("HH:mm:ss.fff"), ev, hwnd.ToInt64(), pid, t.ToString(), GetForegroundWindow() == hwnd });
  };
  public static void Pump() { MSG m; while (PeekMessageW(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessageW(ref m); } }
}
"@
$fg = [TW]::SetWinEventHook(0x0003, 0x0003, [IntPtr]::Zero, [TW]::Cb, 0, 0, 0)
$name = [TW]::SetWinEventHook(0x800C, 0x800C, [IntPtr]::Zero, [TW]::Cb, 0, 0, 0)
"$(Get-Date -Format 'HH:mm:ss.fff')`twatch start pid=$PID process=$Process" | Out-File -Append -Encoding utf8 $Out
$names = @{}
$last = @{}
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  [TW]::Pump()
  $e = $null
  while ([TW]::Q.TryDequeue([ref]$e)) {
    $at, $ev, $hwnd, $wpid, $title, $isFg = $e
    if (-not $names.ContainsKey($wpid)) { $names[$wpid] = (Get-Process -Id $wpid -ErrorAction SilentlyContinue).ProcessName }
    $proc = $names[$wpid]
    if ($ev -eq 0x800C) {
      if ($proc -ne $Process -or $last[$hwnd] -eq $title) { continue }
      $last[$hwnd] = $title
      "$at`ttitle`thwnd=$hwnd`tforeground=$isFg`t$title" | Out-File -Append -Encoding utf8 $Out
    } else {
      "$at`tforeground`thwnd=$hwnd`tproc=$proc`t$title" | Out-File -Append -Encoding utf8 $Out
    }
  }
  Start-Sleep -Milliseconds 20
}
[TW]::UnhookWinEvent($fg) | Out-Null
[TW]::UnhookWinEvent($name) | Out-Null
"$(Get-Date -Format 'HH:mm:ss.fff')`twatch end" | Out-File -Append -Encoding utf8 $Out
