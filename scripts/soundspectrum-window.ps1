param(
  [ValidateSet('inputs', 'inspect', 'window', 'prepare', 'close', 'terminate')][string]$Action = 'inspect',
  [int]$ProcessId = 0,
  [int]$OwnerProcessId = 0,
  [string]$ExpectedExecutable = '',
  [string]$StartTimeTicks = '',
  [int]$Width = 800,
  [int]$Height = 450
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
  public class CaptureInput { public string id; public string name; }
  public class WindowInfo { public string windowHandle; public string windowTitle; public int width; public int height; public bool minimized; }
  [DllImport("dsound.dll", CharSet=CharSet.Unicode)] static extern int DirectSoundCaptureEnumerateW(CaptureEnumProc callback, IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr arg);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool AdjustWindowRectEx(ref Rect rect, uint style, bool menu, uint extendedStyle);
  [DllImport("user32.dll", EntryPoint="GetWindowLong")] static extern int GetWindowLong32(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] static extern IntPtr GetWindowLong64(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  static uint WindowStyle(IntPtr hwnd, int index) { return unchecked((uint)(IntPtr.Size == 8 ? GetWindowLong64(hwnd,index).ToInt64() : GetWindowLong32(hwnd,index))); }
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
    var title = new StringBuilder(1024); GetWindowText(hwnd,title,title.Capacity);
    Rect rect; GetClientRect(hwnd,out rect);
    return new WindowInfo { windowHandle = hwnd.ToInt64().ToString(), windowTitle = title.ToString(), width = rect.Right-rect.Left, height = rect.Bottom-rect.Top, minimized = IsIconic(hwnd) };
  }
  public static WindowInfo Prepare(int processId,int width,int height) {
    IntPtr hwnd = Find(processId); if (hwnd == IntPtr.Zero) return null;
    // WGC requires a restored window; SW_SHOWNOACTIVATE keeps keyboard focus elsewhere.
    ShowWindow(hwnd,4);
    Rect rect = new Rect { Right = width, Bottom = height };
    AdjustWindowRectEx(ref rect,WindowStyle(hwnd,-16),false,WindowStyle(hwnd,-20));
    if (!SetWindowPos(hwnd,IntPtr.Zero,32,32,rect.Right-rect.Left,rect.Bottom-rect.Top,0x0010|0x0004|0x0040)) throw new InvalidOperationException("Could not size visualizer window.");
    return Window(processId);
  }
  public static bool Close(int processId) {
    IntPtr hwnd = Find(processId); return hwnd != IntPtr.Zero && PostMessage(hwnd,0x0010,IntPtr.Zero,IntPtr.Zero);
  }
}
'@

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
    if ($Width -lt 320 -or $Width -gt 1920 -or $Height -lt 180 -or $Height -gt 1080) { throw 'Visualizer window dimensions are outside supported bounds.' }
    $candidate=Get-VerifiedProcess
    if ($null -eq $candidate) { @{ exited=$true } } else { @{ pid=$candidate.Id; startTimeTicks=$candidate.StartTime.ToUniversalTime().Ticks.ToString(); window=[SoundSpectrumWindow]::Prepare($candidate.Id,$Width,$Height) } }
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
