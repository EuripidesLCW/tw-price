// 台服通貨價格 小程式（Windows）
//
// 在遊戲裡把滑鼠移到物品上按 Ctrl+C，置頂小窗就跳到那個物品的台服通貨交換價格。
//
// 運作方式：
//   1. 用 Windows 的剪貼簿通知（AddClipboardFormatListener）得知複製，不必反覆讀取。
//      只收「看起來是遊戲物品」的文字（有「稀有度 / Rarity」那一行），其他複製內容（密碼、網址…）一律不碰。
//   2. 在本機 127.0.0.1 開一個小伺服器：頁面與價格資料直接轉自網站（永遠是雲端最新），
//      /clip 提供最後一次複製的物品文字給頁面。只接受本機位址的請求（擋 DNS rebinding）。
//   3. 用內建的 Edge（或 Chrome）以 App 模式開小窗並設為最上層。
//
// 編譯：build-exe.cmd（使用 Windows 內建的 .NET Framework 4 C# 編譯器，語法為 C# 5）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class App
{
    const string Site = "https://euripideslcw.github.io/tw-price/";
    const int BasePort = 47811;
    static int Port;
    static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TwPriceOverlay");

    // 最後一次複製到的物品
    static readonly object Lk = new object();
    static int Seq;
    static string ClipText = "";
    static long ClipAt;

    static bool KeepTop = true;
    static NotifyIcon Tray;

    [STAThread]
    static void Main(string[] args)
    {
        Directory.CreateDirectory(Dir);
        bool first;
        var single = new Mutex(true, "TwPriceOverlay.Singleton", out first);
        if (!first)
        {
            // 已經在執行：只再開一次小窗
            int p;
            Port = int.TryParse(ReadFile("port.txt"), out p) ? p : BasePort;
            OpenWindow(false);
            return;
        }
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        if (!StartServer())
        {
            MessageBox.Show("無法啟動本機服務（連接埠被占用）。", "台服通貨價格", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        File.WriteAllText(Path.Combine(Dir, "port.txt"), Port.ToString());

        Application.EnableVisualStyles();
        var clip = new ClipWatcher();
        Tray = new NotifyIcon();
        Tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Tray.Text = "台服通貨價格（遊戲裡 Ctrl+C 查價）";
        var menu = new ContextMenuStrip();
        menu.Items.Add("開啟置頂小窗", null, delegate { OpenWindow(false); });
        menu.Items.Add("開啟完整版面（雙螢幕用）", null, delegate { OpenWindow(true); });
        var top = new ToolStripMenuItem("小窗保持在最上層");
        top.Checked = true;
        top.Click += delegate { KeepTop = !KeepTop; top.Checked = KeepTop; ApplyTop(); };
        menu.Items.Add(top);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("結束", null, delegate { Tray.Visible = false; Application.Exit(); });
        Tray.ContextMenuStrip = menu;
        Tray.DoubleClick += delegate { OpenWindow(false); };
        Tray.Visible = true;
        Tray.ShowBalloonTip(4000, "台服通貨價格", "已啟動。遊戲裡把滑鼠移到物品上按 Ctrl+C，小窗就會顯示價格。右下角圖示可重新開啟或結束。", ToolTipIcon.Info);

        OpenWindow(false);
        Application.Run();
        clip.Dispose();
        GC.KeepAlive(single);
    }

    static string ReadFile(string name)
    {
        try { return File.ReadAllText(Path.Combine(Dir, name)).Trim(); } catch { return ""; }
    }

    // ── 剪貼簿 ───────────────────────────────────────────────
    static readonly Regex ItemLike = new Regex(@"^\s*(稀有度|Rarity)\s*[:：]", RegexOptions.Multiline);

    class ClipWatcher : NativeWindow, IDisposable
    {
        [DllImport("user32.dll")] static extern bool AddClipboardFormatListener(IntPtr h);
        [DllImport("user32.dll")] static extern bool RemoveClipboardFormatListener(IntPtr h);
        const int WM_CLIPBOARDUPDATE = 0x031D;

        public ClipWatcher()
        {
            CreateHandle(new CreateParams());
            AddClipboardFormatListener(Handle);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_CLIPBOARDUPDATE) Read();
            base.WndProc(ref m);
        }

        static void Read()
        {
            // 遊戲剛寫入時剪貼簿可能還被占用，重試幾次
            for (int i = 0; i < 5; i++)
            {
                try
                {
                    if (!Clipboard.ContainsText()) return;
                    string t = Clipboard.GetText();
                    if (t.Length > 8000 || !ItemLike.IsMatch(t)) return; // 不是遊戲物品：不收、不轉交
                    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    lock (Lk)
                    {
                        // 一次複製 Windows 會連發好幾次通知；同樣內容 1.5 秒內只算一次（之後再複製同一顆照樣會跳）
                        if (t == ClipText && now - ClipAt < 1500) return;
                        Seq++; ClipText = t; ClipAt = now;
                    }
                    return;
                }
                catch (ExternalException) { Thread.Sleep(40); }
            }
        }

        public void Dispose()
        {
            RemoveClipboardFormatListener(Handle);
            DestroyHandle();
        }
    }

    // ── 本機伺服器 ───────────────────────────────────────────
    static readonly Dictionary<string, byte[]> Cache = new Dictionary<string, byte[]>();

    static bool StartServer()
    {
        for (int p = BasePort; p < BasePort + 10; p++)
        {
            try
            {
                var l = new TcpListener(IPAddress.Loopback, p);
                l.Start();
                Port = p;
                var t = new Thread(delegate () { Accept(l); });
                t.IsBackground = true;
                t.Start();
                return true;
            }
            catch (SocketException) { }
        }
        return false;
    }

    static void Accept(TcpListener l)
    {
        while (true)
        {
            TcpClient c;
            try { c = l.AcceptTcpClient(); } catch { return; }
            ThreadPool.QueueUserWorkItem(delegate { Handle(c); });
        }
    }

    static void Handle(TcpClient c)
    {
        using (c)
        {
            try
            {
                c.ReceiveTimeout = 5000;
                var s = c.GetStream();
                string head = ReadHead(s);
                string[] lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
                string[] req = lines[0].Split(' ');
                if (req.Length < 2 || req[0] != "GET") { Send(s, 405, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("method not allowed")); return; }
                string host = "";
                foreach (var h in lines)
                    if (h.StartsWith("Host:", StringComparison.OrdinalIgnoreCase)) host = h.Substring(5).Trim().ToLowerInvariant();
                // 只服務本機位址：其他網站即使用 DNS rebinding 指到 127.0.0.1，Host 也不會是這兩個
                if (host != "127.0.0.1:" + Port && host != "localhost:" + Port) { Send(s, 403, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("forbidden")); return; }
                string path = req[1];
                int q = path.IndexOf('?');
                if (q >= 0) path = path.Substring(0, q);

                if (path == "/clip")
                {
                    string json;
                    lock (Lk) json = "{\"seq\":" + Seq + ",\"at\":" + ClipAt + ",\"text\":" + Json(ClipText) + "}";
                    Send(s, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(json));
                }
                else if (path == "/" || path == "/index.html") Send(s, 200, "text/html; charset=utf-8", Proxy("index.html"));
                else if (path == "/data.js") Send(s, 200, "text/javascript; charset=utf-8", Proxy("data.js"));
                else Send(s, 404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("not found"));
            }
            catch { }
        }
    }

    static string ReadHead(NetworkStream s)
    {
        var buf = new List<byte>();
        int b;
        while (buf.Count < 16384 && (b = s.ReadByte()) >= 0)
        {
            buf.Add((byte)b);
            int n = buf.Count;
            if (n >= 4 && buf[n - 4] == 13 && buf[n - 3] == 10 && buf[n - 2] == 13 && buf[n - 1] == 10) break;
        }
        return Encoding.ASCII.GetString(buf.ToArray());
    }

    // 頁面與資料轉自網站；暫時連不上時用上一份（並在頁面的資料時間上看得出是舊的）
    static byte[] Proxy(string name)
    {
        try
        {
            using (var w = new WebClient())
            {
                w.Headers[HttpRequestHeader.CacheControl] = "no-cache";
                byte[] d = w.DownloadData(Site + name + "?t=" + DateTime.UtcNow.Ticks);
                lock (Cache) Cache[name] = d;
                return d;
            }
        }
        catch
        {
            lock (Cache) if (Cache.ContainsKey(name)) return Cache[name];
            return Encoding.UTF8.GetBytes(name == "data.js" ? "" : "<meta charset=utf-8><p style='font:16px sans-serif;padding:20px'>連不上網站，請確認網路後重新開啟。</p>");
        }
    }

    static void Send(NetworkStream s, int code, string type, byte[] body)
    {
        string reason = code == 200 ? "OK" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : "Error";
        byte[] h = Encoding.ASCII.GetBytes("HTTP/1.1 " + code + " " + reason + "\r\nContent-Type: " + type +
            "\r\nContent-Length: " + body.Length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
        s.Write(h, 0, h.Length);
        s.Write(body, 0, body.Length);
    }

    static string Json(string t)
    {
        var sb = new StringBuilder("\"");
        foreach (char ch in t)
        {
            if (ch == '"') sb.Append("\\\"");
            else if (ch == '\\') sb.Append("\\\\");
            else if (ch < 0x20) sb.Append("\\u" + ((int)ch).ToString("x4"));
            else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }

    // ── 瀏覽器小窗 ───────────────────────────────────────────
    // 使用者在 Windows 設定的預設瀏覽器（https 的關聯程式）；讀不到就回傳 null
    static string DefaultBrowserExe()
    {
        try
        {
            string prog = null;
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice"))
                if (k != null) prog = k.GetValue("ProgId") as string;
            if (string.IsNullOrEmpty(prog)) return null;
            string cmd = null;
            using (var c = Microsoft.Win32.Registry.ClassesRoot.OpenSubKey(prog + @"\shell\open\command"))
                if (c != null) cmd = c.GetValue("") as string;
            if (string.IsNullOrEmpty(cmd)) return null;
            // 形如 "C:\...\chrome.exe" --single-argument %1
            string exe = cmd.StartsWith("\"") ? cmd.Substring(1, cmd.IndexOf('"', 1) - 1) : cmd.Split(' ')[0];
            return File.Exists(exe) ? exe : null;
        }
        catch { return null; }
    }

    // 支援 --app 獨立小窗模式的 Chromium 系瀏覽器
    static readonly string[] AppCapable = { "chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe" };

    static void OpenWindow(bool wide)
    {
        string url = "http://127.0.0.1:" + Port + "/" + (wide ? "" : "?overlay=1");
        string exe = DefaultBrowserExe();
        bool app = exe != null && Array.IndexOf(AppCapable, Path.GetFileName(exe).ToLowerInvariant()) >= 0;
        if (!app)
        {
            // 預設瀏覽器不支援獨立小窗（例如 Firefox）或讀不到：直接用預設瀏覽器開網頁
            Process.Start(url);
            if (!wide) StartTopThread();
            return;
        }
        // 專用的資料夾：才會是獨立視窗，而且瀏覽器會記住小窗的大小與位置。
        // 停用擴充功能：全新的設定檔會讓「全電腦安裝」的擴充功能（防毒、廣告阻擋…）跳出歡迎頁，多開一個瀏覽器視窗。
        // 這些設定只影響小窗自己的設定檔，不動使用者平常的瀏覽器。
        string profile = Path.Combine(Dir, wide ? "profile-wide" : "profile-overlay");
        string args = "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" " +
            (wide ? "--window-size=1100,900" : "--window-size=420,820") +
            " --no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-features=Translate";
        Process.Start(exe, args);
        if (!wide) StartTopThread();
    }

    static void StartTopThread()
    {
        var t = new Thread(delegate () { for (int i = 0; i < 40; i++) { Thread.Sleep(400); if (ApplyTop()) return; } });
        t.IsBackground = true;
        t.Start();
    }

    // ── 置頂 ─────────────────────────────────────────────────
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

    // 小窗頁面的標題含「疊加」（網站的疊加版面會把標題改成「台服通貨價格 疊加」）
    static bool ApplyTop()
    {
        bool found = false;
        EnumWindows(delegate (IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, 256);
            if (sb.ToString().Contains("疊加"))
            {
                // HWND_TOPMOST = -1 / HWND_NOTOPMOST = -2；SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
                SetWindowPos(h, new IntPtr(KeepTop ? -1 : -2), 0, 0, 0, 0, 0x0013);
                found = true;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
