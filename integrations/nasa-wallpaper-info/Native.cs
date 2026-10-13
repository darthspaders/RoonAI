using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace RabbitHole.NasaDesktopInfo
{
    [StructLayout(LayoutKind.Sequential)]
    public struct NativeRect { public int Left, Top, Right, Bottom; }
    public sealed class WallpaperMonitor
    {
        public string Id, Path;
        public NativeRect Bounds;
        public ImageInfo Info;
        public string Reason;
    }
    // Vtable order is defined by shobjidl_core.h. Only the getters below are called.
    [ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDesktopWallpaper
    {
        void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitor, [MarshalAs(UnmanagedType.LPWStr)] string path);
        [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitor);
        [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint index);
        uint GetMonitorDevicePathCount();
        [PreserveSig] int GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitor, out NativeRect rectangle);
    }
    public static class Native
    {
        public const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
        public const uint SWP_NOACTIVATE = 0x10, SWP_NOMOVE = 2, SWP_NOSIZE = 1;
        public delegate bool EnumProc(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder buffer, int length);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string type, string name);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out NativeRect rectangle);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        public static string Class(IntPtr window) { var s = new StringBuilder(256); GetClassName(window, s, s.Capacity); return s.ToString(); }
        public static List<WallpaperMonitor> Wallpapers()
        {
            var service = (IDesktopWallpaper)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD")));
            try
            {
                var result = new List<WallpaperMonitor>();
                for (uint i = 0; i < service.GetMonitorDevicePathCount(); i++)
                {
                    var id = service.GetMonitorDevicePathAt(i);
                    NativeRect bounds;
                    int resultCode = service.GetMonitorRECT(id, out bounds);
                    // Windows remembers disconnected displays. This PC also returns E_FAIL
                    // for a remembered display, while the attached monitor returns S_OK.
                    if (resultCode == 1 || resultCode == unchecked((int)0x80004005)) continue;
                    Marshal.ThrowExceptionForHR(resultCode);
                    if (bounds.Right > bounds.Left && bounds.Bottom > bounds.Top)
                        result.Add(new WallpaperMonitor { Id = id, Bounds = bounds, Path = service.GetWallpaper(id) });
                }
                return result;
            }
            finally { Marshal.ReleaseComObject(service); }
        }
        public static IntPtr DesktopHost()
        {
            IntPtr host = IntPtr.Zero;
            EnumWindows(delegate(IntPtr window, IntPtr ignored) {
                var type = Class(window);
                if ((type == "Progman" || type == "WorkerW") && IsWindowVisible(window) && FindWindowEx(window, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
                { host = window; return false; }
                return true;
            }, IntPtr.Zero);
            return host;
        }
        public static bool PlaceAtDesktop(IntPtr window, HashSet<IntPtr> captions, int x, int y, int width, int height)
        {
            var host = DesktopHost();
            if (host == IntPtr.Zero) { ShowWindow(window, 0); return false; }
            // Place ONLY our window immediately above Explorer's existing desktop layer.
            // Never TOPMOST, SetParent, create WorkerW, inject into Explorer, or move other windows.
            var previous = GetWindow(host, 3); // GW_HWNDPREV
            while (captions.Contains(previous)) previous = GetWindow(previous, 3);
            if (previous != IntPtr.Zero && (GetWindowLongPtr(previous, GWL_EXSTYLE).ToInt64() & 8) != 0)
                previous = new IntPtr(-2); // HWND_NOTOPMOST even when only topmost windows precede the desktop.
            if (IsIconic(window) || !IsWindowVisible(window)) ShowWindow(window, 4); // SW_SHOWNOACTIVATE
            NativeRect actual; GetWindowRect(window, out actual);
            uint flags = SWP_NOACTIVATE;
            if (actual.Left == x && actual.Top == y) flags |= SWP_NOMOVE;
            if (actual.Right - actual.Left == width && actual.Bottom - actual.Top == height) flags |= SWP_NOSIZE;
            return SetWindowPos(window, previous, x, y, width, height, flags);
        }
        public static object Layers()
        {
            var rows = new List<object>();
            EnumWindows(delegate(IntPtr w, IntPtr ignored) {
                if (!IsWindowVisible(w)) return true;
                uint pid; GetWindowThreadProcessId(w, out pid);
                NativeRect bounds; GetWindowRect(w, out bounds);
                rows.Add(new { handle = w.ToInt64(), type = Class(w), pid = pid, topmost = (GetWindowLongPtr(w, GWL_EXSTYLE).ToInt64() & 8) != 0, minimized = IsIconic(w), bounds = bounds });
                return true;
            }, IntPtr.Zero);
            return rows;
        }
    }
}
