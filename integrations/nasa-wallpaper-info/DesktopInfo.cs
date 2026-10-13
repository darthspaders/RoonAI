using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace RabbitHole.NasaDesktopInfo
{
    public static class Program
    {
        public static string Root, State, InstanceKey;
        static string Argument(string[] args, string key)
        {
            int index = Array.IndexOf(args, key);
            return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
        }
        public static void WriteJson(string filename, object value)
        {
            Directory.CreateDirectory(State);
            var destination = System.IO.Path.Combine(State, filename);
            var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(value), new UTF8Encoding(false));
                if (File.Exists(destination)) File.Replace(temporary, destination, null);
                else File.Move(temporary, destination);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        public static void Event(string type, object value)
        {
            try
            {
                var file = System.IO.Path.Combine(State, "events.jsonl");
                if (File.Exists(file) && new FileInfo(file).Length > 1024 * 1024)
                    WriteJson("last-event.json", new { at = DateTime.UtcNow, type = type, value = value });
                else File.AppendAllText(file, new JavaScriptSerializer().Serialize(new { at = DateTime.UtcNow.ToString("o"), type = type, value = value }) + "\n", new UTF8Encoding(false));
            }
            catch (IOException) { }
        }
        [STAThread]
        public static int Main(string[] args)
        {
            Root = System.IO.Path.GetFullPath(Argument(args, "--root") ?? System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", ".."));
            State = System.IO.Path.Combine(Root, "data", "nasa-wallpaper-info");
            InstanceKey = "Local\\RabbitHole.NasaInfo." + Catalog.KeyHash(Root.ToLowerInvariant() + Environment.UserName);
            try
            {
                if (args.Contains("--stop"))
                {
                    EventWaitHandle stop;
                    if (EventWaitHandle.TryOpenExisting(InstanceKey + ".stop", out stop)) using (stop) stop.Set();
                    return 0;
                }
                if (args.Contains("--inspect"))
                {
                    var monitors = Native.Wallpapers();
                    foreach (var monitor in monitors) monitor.Info = Catalog.Resolve(Root, monitor.Path, out monitor.Reason);
                    WriteJson("inspection.json", new { at = DateTime.UtcNow.ToString("o"), monitors = monitors, desktopHost = Native.DesktopHost().ToInt64(), layers = Native.Layers() });
                    return 0;
                }
                if (args.Contains("--render-caption"))
                {
                    EventWaitHandle render;
                    if (EventWaitHandle.TryOpenExisting(InstanceKey + ".render", out render)) using (render) render.Set();
                    return 0;
                }
                bool first;
                using (var mutex = new Mutex(true, InstanceKey, out first))
                {
                    if (!first)
                    {
                        if (args.Contains("--details"))
                        {
                            EventWaitHandle show;
                            if (EventWaitHandle.TryOpenExisting(InstanceKey + ".details", out show)) using (show) show.Set();
                        }
                        return 0;
                    }
                    Directory.CreateDirectory(State);
                    var app = new DesktopApp(args.Contains("--details"));
                    app.Run();
                    mutex.ReleaseMutex();
                }
                return 0;
            }
            catch (Exception error)
            {
                try { WriteJson("error.json", new { at = DateTime.UtcNow.ToString("o"), message = error.Message, type = error.GetType().Name, stack = error.StackTrace }); } catch { }
                return 1;
            }
        }
    }

    public sealed class DesktopApp : Application
    {
        readonly Dictionary<string, Caption> captions = new Dictionary<string, Caption>();
        readonly EventWaitHandle stop = new EventWaitHandle(false, EventResetMode.ManualReset, Program.InstanceKey + ".stop");
        readonly EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, Program.InstanceKey + ".details");
        readonly EventWaitHandle render = new EventWaitHandle(false, EventResetMode.AutoReset, Program.InstanceKey + ".render");
        Forms.NotifyIcon tray;
        DispatcherTimer layoutTimer;
        Thread watcher;
        List<WallpaperMonitor> monitors = new List<WallpaperMonitor>();
        Details details;
        bool initialDetails;
        DateTime lastStatus = DateTime.MinValue;
        string lastError = "";
        public DesktopApp(bool openDetails) { initialDetails = openDetails; ShutdownMode = ShutdownMode.OnExplicitShutdown; }
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            var menu = new Forms.ContextMenuStrip();
            menu.Items.Add("Open wallpaper details", null, delegate { ShowDetails(null); });
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add("Exit NASA information", null, delegate { Shutdown(); });
            tray = new Forms.NotifyIcon { Icon = System.Drawing.SystemIcons.Information, Text = "NASA wallpaper information", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += delegate { ShowDetails(null); };
            layoutTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            layoutTimer.Tick += delegate {
                if (stop.WaitOne(0)) { Shutdown(); return; }
                if (show.WaitOne(0)) ShowDetails(null);
                if (render.WaitOne(0)) foreach (var caption in captions.Values) caption.RenderProof();
                PlaceCaptions();
                if ((DateTime.UtcNow - lastStatus).TotalSeconds >= 15) SaveStatus("running");
            };
            layoutTimer.Start();
            watcher = new Thread(Watch) { IsBackground = true, Name = "NASA wallpaper metadata", Priority = ThreadPriority.BelowNormal };
            watcher.SetApartmentState(ApartmentState.STA);
            watcher.Start();
            Program.Event("started", new { pid = Process.GetCurrentProcess().Id });
        }
        static string Identity(WallpaperMonitor monitor)
        {
            var file = String.IsNullOrWhiteSpace(monitor.Path) ? null : new FileInfo(monitor.Path);
            return monitor.Id + "|" + monitor.Path + "|" + (file != null && file.Exists ? file.Length + ":" + file.LastWriteTimeUtc.Ticks : "missing") +
                "|" + monitor.Bounds.Left + "," + monitor.Bounds.Top + "," + monitor.Bounds.Right + "," + monitor.Bounds.Bottom;
        }
        void Watch()
        {
            string lastIdentity = null;
            bool unresolved = false;
            DateTime retry = DateTime.MinValue;
            while (!stop.WaitOne(0))
            {
                try
                {
                    var next = Native.Wallpapers();
                    var identity = String.Join("\n", next.Select(Identity));
                    var receipt = new FileInfo(Path.Combine(Program.Root, "data", "nasa-wallpaper", "source-links.json"));
                    var receiptIdentity = receipt.Exists ? receipt.LastWriteTimeUtc.Ticks.ToString() : "missing";
                    var combinedIdentity = identity + "|sources:" + receiptIdentity;
                    if (combinedIdentity != lastIdentity || (unresolved && DateTime.UtcNow >= retry))
                    {
                        unresolved = false;
                        foreach (var monitor in next)
                        {
                            try { monitor.Info = Catalog.Resolve(Program.Root, monitor.Path, out monitor.Reason); }
                            catch (Exception error) { monitor.Info = null; monitor.Reason = "Catalog unavailable: " + error.Message; }
                            if (monitor.Info == null) unresolved = true;
                        }
                        // Re-read Windows after metadata IO: never publish a caption for an image
                        // which the slideshow replaced while a catalog lookup was in progress.
                        if (String.Join("\n", Native.Wallpapers().Select(Identity)) != identity) continue;
                        SourceLinkRefresh.Poll(next.Where(m => m.Info != null).Select(m => m.Info.Id).ToArray());
                        lastIdentity = combinedIdentity;
                        retry = DateTime.UtcNow.AddSeconds(15);
                        Dispatcher.BeginInvoke(new Action(delegate { Apply(next, ""); }));
                    }
                    SourceLinkRefresh.Poll(new string[0]);
                }
                catch (Exception error)
                {
                    lastIdentity = null;
                    var message = "Windows wallpaper lookup unavailable: " + error.Message;
                    Dispatcher.BeginInvoke(new Action(delegate { Apply(new List<WallpaperMonitor>(), message); }));
                }
                if (stop.WaitOne(2000)) return;
            }
        }
        void Apply(List<WallpaperMonitor> next, string error)
        {
            if (stop.WaitOne(0)) return;
            string before = String.Join("|", monitors.Select(m => m.Path + ":" + (m.Info == null ? m.Reason : m.Info.Id)));
            monitors = next; lastError = error;
            foreach (var id in captions.Keys.Where(id => !next.Any(m => m.Id == id)).ToArray()) { captions[id].Close(); captions.Remove(id); }
            foreach (var monitor in next)
            {
                Caption caption;
                if (monitor.Info == null)
                {
                    if (captions.TryGetValue(monitor.Id, out caption)) caption.Clear();
                    continue;
                }
                if (!captions.TryGetValue(monitor.Id, out caption))
                {
                    caption = new Caption(delegate(ImageInfo info) { ShowDetails(info); });
                    captions[monitor.Id] = caption;
                }
                caption.SetImage(monitor);
            }
            PlaceCaptions();
            if (details != null) details.SetCurrent(next.Any(m => m.Info != null && m.Info.Path == details.Image.Path));
            if (initialDetails && next.Any(m => m.Info != null)) { initialDetails = false; ShowDetails(null); }
            string after = String.Join("|", next.Select(m => m.Path + ":" + (m.Info == null ? m.Reason : m.Info.Id)));
            if (before != after || error != "") Program.Event("wallpaper", next.Select(m => new { path = m.Path, id = m.Info == null ? null : m.Info.Id, title = m.Info == null ? null : m.Info.Title, reason = m.Reason }).ToArray());
            SaveStatus("running");
        }
        void PlaceCaptions()
        {
            var handles = new HashSet<IntPtr>(captions.Values.Select(c => c.Handle).Where(h => h != IntPtr.Zero));
            foreach (var caption in captions.Values) caption.Place(handles);
        }
        void ShowDetails(ImageInfo image)
        {
            image = image ?? monitors.Where(m => m.Info != null).Select(m => m.Info).FirstOrDefault();
            if (image == null)
            {
                MessageBox.Show("The current wallpaper has no verified match in the NASA catalog. The title will appear automatically when Windows displays a published NASA image.", "NASA wallpaper information", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            if (details != null) details.Close();
            details = new Details(image);
            details.Closed += delegate { details = null; SaveStatus("running"); };
            details.Show();
            details.Activate();
            Program.Event("details-opened", new { id = image.Id });
            SaveStatus("running");
        }
        void SaveStatus(string status)
        {
            try
            {
                lastStatus = DateTime.UtcNow;
                Program.WriteJson("status.json", new { at = lastStatus.ToString("o"), status = status, pid = Process.GetCurrentProcess().Id,
                    error = lastError, detailsOpen = details != null, desktopHost = Native.DesktopHost().ToInt64(),
                    monitors = monitors.Select(m => new { path = m.Path, id = m.Info == null ? null : m.Info.Id, title = m.Info == null ? null : m.Info.Title, reason = m.Reason }).ToArray(),
                    captions = captions.Values.Select(c => new { handle = c.Handle.ToInt64(), visible = c.IsVisible, width = c.ActualWidth, height = c.ActualHeight,
                        topmost = c.Handle != IntPtr.Zero && (Native.GetWindowLongPtr(c.Handle, Native.GWL_EXSTYLE).ToInt64() & 8) != 0 }).ToArray() });
            }
            catch (IOException) { }
        }
        protected override void OnExit(ExitEventArgs e)
        {
            stop.Set();
            if (layoutTimer != null) layoutTimer.Stop();
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            SaveStatus("stopped");
            Program.Event("stopped", new { pid = Process.GetCurrentProcess().Id });
            // The background watcher exits at its next wait; no app, collector or visualizer is stopped.
            base.OnExit(e);
        }
    }

    // Reuses the existing desktop helper's lifetime. Metadata validation is a bounded
    // independent child; no Rabbit Hole server, pipeline worker or image processing.
    static class SourceLinkRefresh
    {
        static Process child;
        static DateTime next = DateTime.MinValue;
        static string priority = "";
        public static void Poll(string[] ids)
        {
            try
            {
                if (child != null && !child.HasExited) return;
                string wanted = String.Join(",", ids.Where(id => System.Text.RegularExpressions.Regex.IsMatch(id, "^nasa-(science-[0-9]+|auto-[a-f0-9]{24})$")));
                if (DateTime.UtcNow < next && (wanted == "" || wanted == priority)) return;
                if (child != null) { child.Dispose(); child = null; }
                next = DateTime.UtcNow.AddMinutes(5); if (wanted != "") priority = wanted;
                var script = Path.Combine(Program.Root, "integrations", "nasa-wallpaper", "source-links.cjs");
                var start = new ProcessStartInfo("node.exe", "\"" + script + "\" --limit 12" + (wanted == "" ? "" : " --ids " + wanted));
                start.UseShellExecute = false; start.CreateNoWindow = true; start.WindowStyle = ProcessWindowStyle.Hidden;
                start.WorkingDirectory = Program.Root;
                child = Process.Start(start);
            }
            catch { next = DateTime.UtcNow.AddMinutes(5); }
        }
    }

    public static class Theme
    {
        public static SolidColorBrush Brush(string hex) { return (SolidColorBrush)new BrushConverter().ConvertFromString(hex); }
        public static readonly Brush Text = Brush("#F2EEF6"), Muted = Brush("#C4BCCD"), Surface = Brush("#18141E");
        public static TextBlock Label(string text, double size, Brush brush)
        {
            return new TextBlock { Text = text, FontSize = size, Foreground = brush, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Segoe UI") };
        }
        public static Style ButtonStyle()
        {
            return (Style)XamlReader.Parse(@"<Style xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' TargetType='Button'>
              <Setter Property='Foreground' Value='#F2EEF6'/><Setter Property='Background' Value='#D918141E'/>
              <Setter Property='BorderBrush' Value='#45C4BCCD'/><Setter Property='BorderThickness' Value='1'/>
              <Setter Property='Padding' Value='16,12'/><Setter Property='Cursor' Value='Hand'/>
              <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'>
                <Border x:Name='surface' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='{TemplateBinding BorderThickness}' CornerRadius='8' Padding='{TemplateBinding Padding}'>
                  <ContentPresenter HorizontalAlignment='{TemplateBinding HorizontalContentAlignment}'/>
                </Border><ControlTemplate.Triggers>
                  <Trigger Property='IsMouseOver' Value='True'><Setter Property='Background' Value='#F22B2333'/></Trigger>
                  <Trigger Property='IsKeyboardFocused' Value='True'><Setter Property='BorderBrush' Value='#FFD6B5F2'/></Trigger>
                  <Trigger Property='IsPressed' Value='True'><Setter Property='Background' Value='#FF35293F'/></Trigger>
                  <Trigger Property='IsEnabled' Value='False'><Setter Property='Opacity' Value='.55'/></Trigger>
                </ControlTemplate.Triggers>
              </ControlTemplate></Setter.Value></Setter></Style>");
        }
    }
    public sealed class Caption : Window
    {
        readonly TextBlock title = Theme.Label("", 15, Theme.Text);
        readonly TextBlock credit = Theme.Label("", 11, Theme.Muted);
        readonly Button button;
        WallpaperMonitor monitor;
        int transition;
        bool hasImage;
        public IntPtr Handle { get; private set; }
        public Caption(Action<ImageInfo> open)
        {
            Title = "NASA desktop title";
            UseLayoutRounding = true; SnapsToDevicePixels = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize; AllowsTransparency = true;
            Background = Brushes.Transparent; ShowInTaskbar = false; ShowActivated = false; Topmost = false;
            SizeToContent = SizeToContent.Height; Width = 380; Opacity = 0;
            title.FontWeight = FontWeights.SemiBold;
            title.LineHeight = 21;
            credit.Margin = new Thickness(0, 4, 0, 0); credit.TextWrapping = TextWrapping.NoWrap; credit.TextTrimming = TextTrimming.CharacterEllipsis;
            var content = new StackPanel(); content.Children.Add(title); content.Children.Add(credit);
            button = new Button { Style = Theme.ButtonStyle(), Content = content, HorizontalContentAlignment = HorizontalAlignment.Stretch, Focusable = false };
            button.Click += delegate { if (monitor != null && hasImage) open(monitor.Info); };
            AutomationProperties.SetHelpText(button, "Open NASA image details. Also available from the NASA information icon in the system tray.");
            Content = button;
            SourceInitialized += delegate {
                Handle = new WindowInteropHelper(this).Handle;
                Native.SetWindowLongPtr(Handle, Native.GWL_EXSTYLE, new IntPtr(Native.GetWindowLongPtr(Handle, Native.GWL_EXSTYLE).ToInt64() | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE));
                HwndSource.FromHwnd(Handle).AddHook(Hook);
            };
        }
        IntPtr Hook(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (message == 0x21) { handled = true; return new IntPtr(3); } // MA_NOACTIVATE: a caption click never raises it over apps.
            return IntPtr.Zero;
        }
        void Fade(double to, int milliseconds, Action completed)
        {
            BeginAnimation(OpacityProperty, null);
            if (!SystemParameters.ClientAreaAnimation || SystemParameters.HighContrast)
            { Opacity = to; if (completed != null) completed(); return; }
            var animation = new DoubleAnimation(Opacity, to, TimeSpan.FromMilliseconds(milliseconds)) { FillBehavior = FillBehavior.Stop };
            animation.Completed += delegate { Opacity = to; if (completed != null) completed(); };
            BeginAnimation(OpacityProperty, animation);
        }
        public void SetImage(WallpaperMonitor next)
        {
            var same = monitor != null && monitor.Info != null && monitor.Info.Path == next.Info.Path && monitor.Info.Title == next.Info.Title && monitor.Info.Credit == next.Info.Credit;
            monitor = next; hasImage = true;
            if (same && IsVisible) return;
            int ticket = ++transition;
            Action update = delegate {
                if (ticket != transition) return;
                title.Text = next.Info.Title; credit.Text = next.Info.Credit;
                credit.Visibility = String.IsNullOrWhiteSpace(credit.Text) ? Visibility.Collapsed : Visibility.Visible;
                button.ToolTip = "View image details";
                AutomationProperties.SetName(button, "View image details: " + next.Info.Title);
                if (SystemParameters.HighContrast) { button.Background = SystemColors.WindowBrush; title.Foreground = SystemColors.WindowTextBrush; credit.Foreground = SystemColors.WindowTextBrush; }
                if (!IsVisible) Show();
                UpdateLayout();
                Fade(1, 200, null);
            };
            if (IsVisible) Fade(0, 120, update); else update();
        }
        public void Clear()
        {
            hasImage = false; int ticket = ++transition;
            Fade(0, 120, delegate { if (ticket == transition) Hide(); });
        }
        public void RenderProof()
        {
            if (!hasImage || !IsVisible) return;
            // Render only our caption control for UI verification, never capture or copy wallpaper pixels.
            var bitmap = new RenderTargetBitmap((int)Math.Ceiling(button.ActualWidth * 2), (int)Math.Ceiling(button.ActualHeight * 2), 192, 192, PixelFormats.Pbgra32);
            bitmap.Render(button);
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (var file = File.Create(System.IO.Path.Combine(Program.State, "caption-preview.png"))) encoder.Save(file);
        }
        public void Place(HashSet<IntPtr> handles)
        {
            if (!hasImage || monitor == null || Handle == IntPtr.Zero) return;
            var rect = monitor.Bounds;
            var screen = Forms.Screen.FromRectangle(new System.Drawing.Rectangle(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top));
            var work = screen.WorkingArea;
            double scale = Math.Max(1, Native.GetDpiForWindow(Handle) / 96.0);
            Width = Math.Min(380, Math.Max(160, work.Width / scale - 48));
            UpdateLayout();
            int width = (int)Math.Ceiling(ActualWidth * scale), height = (int)Math.Ceiling(ActualHeight * scale), gap = (int)(24 * scale);
            Native.PlaceAtDesktop(Handle, handles, work.Right - width - gap, work.Top + gap, width, height);
        }
    }
    public sealed class Details : Window
    {
        public ImageInfo Image { get; private set; }
        readonly TextBlock note = Theme.Label("", 12, Theme.Muted);
        public Details(ImageInfo image)
        {
            Image = image; Title = "NASA image details"; Width = 570; Height = 690; MinWidth = 360; MinHeight = 380;
            UseLayoutRounding = true; SnapsToDevicePixels = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            MaxHeight = SystemParameters.WorkArea.Height - 32;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Background = Theme.Surface; Foreground = Theme.Text; FontFamily = new FontFamily("Segoe UI");
            Topmost = false; ShowInTaskbar = true;
            SourceInitialized += delegate { int dark = 1; Native.DwmSetWindowAttribute(new WindowInteropHelper(this).Handle, 20, ref dark, 4); };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape) { e.Handled = true; Close(); } };
            var layout = new DockPanel { Margin = new Thickness(28, 24, 28, 24) };
            var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 20, 0, 0) };
            var source = new Button { Content = "Open NASA source", MinHeight = 42, Style = Theme.ButtonStyle() };
            Action updateSource = delegate {
                string kind;
                image.SourceUrl = Catalog.ValidatedSource(Program.Root, image.Id, image.Sha256, out kind);
                image.SourceKind = kind;
                source.IsEnabled = image.SourceUrl != null;
                source.Content = kind == "image" ? "Open NASA image" : "Open NASA source";
                source.ToolTip = image.SourceUrl == null ? "An official source link is awaiting validation. This panel updates when the shared check completes."
                    : (kind == "image" ? "The NASA page was unavailable; open its verified official image.\n" : "") + image.SourceUrl;
            };
            updateSource();
            var sourceTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            sourceTimer.Tick += delegate { updateSource(); }; sourceTimer.Start();
            Closed += delegate { sourceTimer.Stop(); };
            source.Click += delegate {
                updateSource();
                var url = Catalog.NasaUrl(image.SourceUrl);
                if (url == null) return;
                try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
                catch (Exception error) { MessageBox.Show(this, "The NASA link could not be opened. " + error.Message, "NASA source", MessageBoxButton.OK, MessageBoxImage.Information); }
            };
            var close = new Button { Content = "Close", MinHeight = 42, Style = Theme.ButtonStyle(), Margin = new Thickness(10, 0, 0, 0) };
            close.Click += delegate { Close(); };
            actions.Children.Add(source); actions.Children.Add(close); DockPanel.SetDock(actions, Dock.Bottom); layout.Children.Add(actions);
            var body = new StackPanel();
            var heading = Theme.Label(image.Title, 25, Theme.Text); heading.FontWeight = FontWeights.SemiBold; heading.Margin = new Thickness(0, 0, 0, 10); body.Children.Add(heading);
            if (!String.IsNullOrWhiteSpace(image.Target) && image.Target != image.Title) Add(body, "Target", image.Target);
            var description = Theme.Label(String.IsNullOrWhiteSpace(image.Description) ? "No description was supplied in this NASA catalog record." : image.Description, 14, Theme.Text);
            description.LineHeight = 22; description.Margin = new Thickness(0, 8, 0, 8); body.Children.Add(description);
            Add(body, "Mission", image.Mission);
            Add(body, "Credit", image.Credit);
            Add(body, "Publication date", image.Publication);
            if (!String.IsNullOrWhiteSpace(image.DateKind)) { var kind = Theme.Label(image.DateKind, 12, Theme.Muted); kind.Margin = new Thickness(0, 4, 0, 0); body.Children.Add(kind); }
            Add(body, "Original resolution (NASA metadata)", image.OriginalResolution);
            if (!String.IsNullOrWhiteSpace(image.DownloadResolution)) Add(body, "Downloaded source resolution", image.DownloadResolution);
            note.Margin = new Thickness(0, 18, 0, 0); body.Children.Add(note);
            layout.Children.Add(new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Padding = new Thickness(0, 0, 12, 0) });
            Content = layout;
            Resources.Add(typeof(System.Windows.Controls.Primitives.ScrollBar), XamlReader.Parse(@"<Style xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' TargetType='ScrollBar'>
              <Setter Property='Width' Value='10'/><Setter Property='Background' Value='Transparent'/>
              <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='ScrollBar'>
                <Track xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' x:Name='PART_Track' IsDirectionReversed='True' Orientation='Vertical'>
                  <Track.DecreaseRepeatButton><RepeatButton Command='ScrollBar.PageUpCommand' Opacity='0'/></Track.DecreaseRepeatButton>
                  <Track.Thumb><Thumb><Thumb.Template><ControlTemplate TargetType='Thumb'><Border Background='#6E617B' CornerRadius='4' Margin='2,0'/></ControlTemplate></Thumb.Template></Thumb></Track.Thumb>
                  <Track.IncreaseRepeatButton><RepeatButton Command='ScrollBar.PageDownCommand' Opacity='0'/></Track.IncreaseRepeatButton>
                </Track>
              </ControlTemplate></Setter.Value></Setter></Style>"));
            Loaded += delegate { close.Focus(); };
        }
        static void Add(Panel parent, string label, string value)
        {
            var title = Theme.Label(label, 12, Theme.Muted); title.Margin = new Thickness(0, 16, 0, 4); parent.Children.Add(title);
            parent.Children.Add(Theme.Label(String.IsNullOrWhiteSpace(value) ? "Not supplied in the NASA catalog." : value, 14, Theme.Text));
        }
        public void SetCurrent(bool current) { note.Text = current ? "" : "The desktop has moved to another image. These are the details you opened."; }
    }
}
