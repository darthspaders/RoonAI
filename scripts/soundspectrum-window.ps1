param(
  [ValidateSet('inputs', 'inspect', 'window', 'prepare', 'title', 'close', 'terminate')][string]$Action = 'inspect',
  [int]$ProcessId = 0,
  [int]$OwnerProcessId = 0,
  [string]$ExpectedExecutable = '',
  [string]$StartTimeTicks = '',
  [int]$Width = 800,
  [int]$Height = 450,
  [string]$WindowAlias = '',
  [ValidateSet('windowed', 'borderless-fullscreen')][string]$WindowMode = 'windowed',
  [string]$ExpectedWindowHandle = '',
  [string]$ExpectedWindowClass = '',
  [string]$ExpectedWindowTitle = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SoundSpectrumWindow {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static SoundSpectrumWindow() { SetProcessDPIAware(); }
  public delegate bool EnumWindowProc(IntPtr hwnd, IntPtr arg);
  public delegate bool CaptureEnumProc(IntPtr guid, IntPtr description, IntPtr module, IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  public class CaptureInput { public string id; public string name; }
  public class WindowInfo { public string windowHandle; public string windowTitle; public string windowClass; public int width; public int height; public bool minimized; }
  [DllImport("dsound.dll", CharSet=CharSet.Unicode)] static extern int DirectSoundCaptureEnumerateW(CaptureEnumProc callback, IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr arg);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool SetWindowText(IntPtr hwnd, string text);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern bool AdjustWindowRectEx(ref Rect rect, uint style, bool menu, uint extendedStyle);
  [DllImport("user32.dll", EntryPoint="GetWindowLong")] static extern int GetWindowLong32(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] static extern IntPtr GetWindowLong64(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLong", SetLastError=true)] static extern int SetWindowLong32(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtr", SetLastError=true)] static extern IntPtr SetWindowLong64(IntPtr hwnd, int index, IntPtr value);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  static uint WindowStyle(IntPtr hwnd, int index) { return unchecked((uint)(IntPtr.Size == 8 ? GetWindowLong64(hwnd,index).ToInt64() : GetWindowLong32(hwnd,index))); }
  static void SetStyle(IntPtr hwnd, int index, uint style) {
    SetLastError(0);
    long previous = IntPtr.Size == 8 ? SetWindowLong64(hwnd,index,new IntPtr(unchecked((int)style))).ToInt64() : SetWindowLong32(hwnd,index,unchecked((int)style));
    if (previous == 0 && Marshal.GetLastWin32Error() != 0) throw new InvalidOperationException("Could not change the owned visualizer window style.");
  }
  public static CaptureInput[] Inputs() {
    var inputs = new List<CaptureInput>();
    CaptureEnumProc callback = (guid,description,module,context) => {
      // The null GUID is the implicit default. Never expose it as an exact source.
      if (guid != IntPtr.Zero) inputs.Add(new CaptureInput { id = ((Guid)Marshal.PtrToStructure(guid,typeof(Guid))).ToString(), name = Marshal.PtrToStringUni(description) });
      return true;
    };
    int error = DirectSoundCaptureEnumerateW(callback,IntPtr.Zero);
    GC.KeepAlive(callback);
    if (error != 0) throw new InvalidOperationException("Could not enumerate Windows capture inputs.");
    return inputs.ToArray();
  }
  static IntPtr Find(int processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindowProc callback = (hwnd,arg) => {
      uint pid; GetWindowThreadProcessId(hwnd,out pid);
      if (pid != processId || !IsWindowVisible(hwnd)) return true;
      Rect rect; if (!GetClientRect(hwnd,out rect) || rect.Right <= 100 || rect.Bottom <= 100) return true;
      found = hwnd; return false;
    };
    EnumWindows(callback,IntPtr.Zero); GC.KeepAlive(callback); return found;
  }
  public static WindowInfo Window(int processId) {
    IntPtr hwnd = Find(processId); if (hwnd == IntPtr.Zero) return null;
    return WindowInfoForHandle(hwnd);
  }
  static WindowInfo WindowInfoForHandle(IntPtr hwnd) {
    var title = new StringBuilder(1024); GetWindowText(hwnd,title,title.Capacity);
    var windowClass = new StringBuilder(256); GetClassName(hwnd,windowClass,windowClass.Capacity);
    Rect rect; GetClientRect(hwnd,out rect);
    return new WindowInfo { windowHandle = hwnd.ToInt64().ToString(), windowTitle = title.ToString(), windowClass = windowClass.ToString(), width = rect.Right-rect.Left, height = rect.Bottom-rect.Top, minimized = IsIconic(hwnd) };
  }
  public static WindowInfo Prepare(int processId,int width,int height,string alias,string mode,string expectedHandle,string expectedClass,string expectedTitle) {
    IntPtr hwnd = Find(processId); if (hwnd == IntPtr.Zero) return null;
    if (mode == "borderless-fullscreen") {
      if (hwnd.ToInt64().ToString() != expectedHandle) throw new InvalidOperationException("The exact owned visualizer window changed.");
      uint pid; GetWindowThreadProcessId(hwnd,out pid);
      if (pid != processId) throw new InvalidOperationException("The visualizer window ownership changed.");
      var before = WindowInfoForHandle(hwnd);
      if (!String.Equals(before.windowClass,expectedClass,StringComparison.Ordinal) || !String.Equals(before.windowTitle,expectedTitle,StringComparison.Ordinal))
        throw new InvalidOperationException("The exact owned visualizer window identity changed.");
      var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
      IntPtr monitor = MonitorFromWindow(hwnd,2);
      if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor,ref info) || info.Monitor.Right-info.Monitor.Left != width || info.Monitor.Bottom-info.Monitor.Top != height)
        throw new InvalidOperationException("The current monitor resolution does not match the requested visualizer resolution.");
      // Check physical monitor bounds before any style/position change. This is
      // windowed borderless presentation; no display mode or focus is changed.
      uint style = WindowStyle(hwnd,-16), extended = WindowStyle(hwnd,-20);
      Rect oldBounds; if (!GetWindowRect(hwnd,out oldBounds)) throw new InvalidOperationException("Could not preserve the visualizer window bounds.");
      try {
        ShowWindow(hwnd,4);
        SetStyle(hwnd,-16,style & ~0x00CF0000u & ~0x01000000u & ~0x20000000u);
        SetStyle(hwnd,-20,extended & ~0x00020301u);
        if (!SetWindowPos(hwnd,IntPtr.Zero,info.Monitor.Left,info.Monitor.Top,width,height,0x0010|0x0004|0x0020|0x0040))
          throw new InvalidOperationException("Could not fill the owned visualizer monitor.");
        if (!SetWindowText(hwnd,alias)) throw new InvalidOperationException("Could not identify the owned visualizer window.");
        var window = WindowInfoForHandle(hwnd);
        if (window.minimized || window.width != width || window.height != height) throw new InvalidOperationException("The fullscreen client resolution does not match the monitor.");
        return window;
      } catch {
        // Best-effort local rollback before the controller closes its own renderer.
        try { SetStyle(hwnd,-16,style); SetStyle(hwnd,-20,extended); SetWindowPos(hwnd,IntPtr.Zero,oldBounds.Left,oldBounds.Top,oldBounds.Right-oldBounds.Left,oldBounds.Bottom-oldBounds.Top,0x0010|0x0004|0x0020); } catch {}
        throw;
      }
    }
    // WGC requires a restored window; SW_SHOWNOACTIVATE keeps keyboard focus elsewhere.
    ShowWindow(hwnd,4);
    Rect rect = new Rect { Right = width, Bottom = height };
    AdjustWindowRectEx(ref rect,WindowStyle(hwnd,-16),false,WindowStyle(hwnd,-20));
    if (!SetWindowPos(hwnd,IntPtr.Zero,32,32,rect.Right-rect.Left,rect.Bottom-rect.Top,0x0010|0x0004|0x0040)) throw new InvalidOperationException("Could not size visualizer window.");
    if (!String.IsNullOrEmpty(alias) && !SetWindowText(hwnd,alias)) throw new InvalidOperationException("Could not identify the owned visualizer window.");
    return WindowInfoForHandle(hwnd);
  }
  public static bool Title(int processId,string title) {
    IntPtr hwnd = Find(processId); return hwnd != IntPtr.Zero && SetWindowText(hwnd,title);
  }
  public static bool Close(int processId) {
    IntPtr hwnd = Find(processId); return hwnd != IntPtr.Zero && PostMessage(hwnd,0x0010,IntPtr.Zero,IntPtr.Zero);
  }
}
'@

function Get-CaptureAliasProduct {
  param([string]$Alias, [string]$Executable, [string]$ProcessStartTicks)
  # Pure validation: the title is specific to both one product and one owned
  # session. Reject cross-product aliases before inspecting or touching a HWND.
  $taskAliasMatch = [regex]::Match($Alias, '^Rabbit Hole (Aeon|G-Force|WhiteCap) RH-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z')
  if (-not $taskAliasMatch.Success -or $ProcessStartTicks -notmatch '^\d{10,22}\z') { throw 'An exact owned capture identity is required for a visualizer alias.' }
  $taskProductName = $taskAliasMatch.Groups[1].Value
  $taskExecutablePattern = '^' + [regex]::Escape($taskProductName) + ' Standalone(?:\.x64)?\.exe\z'
  if ([IO.Path]::GetFileName($Executable) -notmatch $taskExecutablePattern) { throw 'The capture alias does not match the selected visualizer executable.' }
  return $taskProductName
}

function Get-VerifiedProcess {
  if ($ProcessId -le 0 -or [string]::IsNullOrWhiteSpace($ExpectedExecutable)) { throw 'An exact process identity is required.' }
  $candidate = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $candidate) { return $null }
  $actualPath = $candidate.MainModule.FileName
  if (-not [string]::Equals([System.IO.Path]::GetFullPath($actualPath), [System.IO.Path]::GetFullPath($ExpectedExecutable), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'The process does not belong to the selected visualizer.' }
  if ($StartTimeTicks -and $candidate.StartTime.ToUniversalTime().Ticks.ToString() -ne $StartTimeTicks) { throw 'The visualizer process identity has changed.' }
  return $candidate
}

function Get-CaptureInputs {
  @([SoundSpectrumWindow]::Inputs() | ForEach-Object {
    $inputDevice = $_
    $formFactor = -1
    $interfaceName = ''
    $endpointPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture\{' + $inputDevice.id + '}\Properties'
    if (Test-Path -LiteralPath $endpointPath) {
      $properties = Get-ItemProperty -LiteralPath $endpointPath
      if ($null -ne $properties.'{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},0') { $formFactor = [int]$properties.'{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},0' }
      $interfaceName = [string]$properties.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
    }
    @{ id=$inputDevice.id; name=$inputDevice.name; formFactor=$formFactor; interfaceName=$interfaceName }
  })
}

function Get-DesktopProfile {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $profilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  # Task Scheduler may omit APPDATA/LOCALAPPDATA. Resolve KnownFolders for the
  # actual desktop token instead of deriving a path from the account's name.
  @{
    accountSid = $identity.User.Value
    profilePath = $profilePath
    roamingAppDataPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
    localAppDataPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  }
}

$result = switch ($Action) {
  'inputs' { @{ inputs = @(Get-CaptureInputs) } }
  'inspect' {
    $knownNames = @('Aeon Standalone','Aeon Standalone.x64','G-Force Standalone','G-Force Standalone.x64','WhiteCap Standalone','WhiteCap Standalone.x64')
    $processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $knownNames -contains $_.ProcessName } | ForEach-Object {
      @{ pid=$_.Id; executable=$_.MainModule.FileName; startTimeTicks=$_.StartTime.ToUniversalTime().Ticks.ToString(); window=[SoundSpectrumWindow]::Window($_.Id) }
    })
    $owner = $null
    if ($OwnerProcessId -gt 0) {
      $ownerProcess = Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue
      if ($null -ne $ownerProcess) { $owner = @{ pid=$ownerProcess.Id; executable=$ownerProcess.MainModule.FileName; startTimeTicks=$ownerProcess.StartTime.ToUniversalTime().Ticks.ToString() } }
    }
    @{ processes=$processes; inputs=@(Get-CaptureInputs); owner=$owner; profile=Get-DesktopProfile }
  }
  'window' {
    $candidate=Get-VerifiedProcess
    if ($null -eq $candidate) { @{ exited=$true } } else { @{ pid=$candidate.Id; startTimeTicks=$candidate.StartTime.ToUniversalTime().Ticks.ToString(); window=[SoundSpectrumWindow]::Window($candidate.Id) } }
  }
  'prepare' {
    $taskFullscreen = $WindowMode -eq 'borderless-fullscreen'
    $taskMaxWidth = if ($taskFullscreen) { 3840 } else { 1920 }
    $taskMaxHeight = if ($taskFullscreen) { 2160 } else { 1080 }
    if ($Width -lt 320 -or $Width -gt $taskMaxWidth -or $Height -lt 180 -or $Height -gt $taskMaxHeight) { throw 'Visualizer window dimensions are outside supported bounds.' }
    $taskCaptureProduct = $null
    if ($WindowAlias) { $taskCaptureProduct = Get-CaptureAliasProduct -Alias $WindowAlias -Executable $ExpectedExecutable -ProcessStartTicks $StartTimeTicks }
    if ($taskFullscreen -and (-not $WindowAlias -or -not $StartTimeTicks -or $ExpectedWindowHandle -notmatch '^\d{1,20}$' -or [decimal]$ExpectedWindowHandle -le 0 -or
        [decimal]$ExpectedWindowHandle -gt [decimal]::Parse('18446744073709551615') -or
        [string]::IsNullOrEmpty($ExpectedWindowClass) -or $ExpectedWindowClass.Length -gt 256 -or $ExpectedWindowClass -match '[\x00-\x1f\x7f]' -or
        [string]::IsNullOrEmpty($ExpectedWindowTitle) -or $ExpectedWindowTitle.Length -gt 1024 -or $ExpectedWindowTitle -match '[\x00-\x1f\x7f]' -or
        -not $taskCaptureProduct)) { throw 'Borderless fullscreen requires an exact owned SoundSpectrum capture identity.' }
    $candidate=Get-VerifiedProcess
    if ($null -eq $candidate) { @{ exited=$true } } else { @{ pid=$candidate.Id; startTimeTicks=$candidate.StartTime.ToUniversalTime().Ticks.ToString(); window=[SoundSpectrumWindow]::Prepare($candidate.Id,$Width,$Height,$WindowAlias,$WindowMode,$ExpectedWindowHandle,$ExpectedWindowClass,$ExpectedWindowTitle) } }
  }
  'title' {
    if (-not $StartTimeTicks -or $WindowAlias.Length -gt 1024 -or $WindowAlias -match '[\x00-\x1f\x7f]') { throw 'An exact owned capture identity and valid title are required.' }
    $candidate=Get-VerifiedProcess
    if ($null -eq $candidate) { @{ exited=$true } } else { @{ renamed=[SoundSpectrumWindow]::Title($candidate.Id,$WindowAlias) } }
  }
  'close' {
    $candidate=Get-VerifiedProcess
    if ($null -eq $candidate) { @{ exited=$true } } else { @{ closed=[SoundSpectrumWindow]::Close($candidate.Id) } }
  }
  'terminate' {
    if (-not $StartTimeTicks) { throw 'An exact process start identity is required to terminate an owned renderer.' }
    $candidate=Get-VerifiedProcess
    if ($null -eq $candidate) { @{ exited=$true } } else { Stop-Process -Id $candidate.Id -Force; @{ terminated=$true } }
  }
}
$result | ConvertTo-Json -Depth 6 -Compress
