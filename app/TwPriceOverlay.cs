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
    // 版本號：改了這個檔案要重新編譯並把這裡加 1；網站的 app-version.json 由 GitHub Actions 依此產生
    const string Version = "1.3.3";
    // 更新簽章的公鑰（RSA-3072）。對應的私鑰只在發布者的電腦上，不在任何網路服務裡：
    // 就算網站或 GitHub 帳號被入侵，沒有私鑰就簽不出能通過驗證的 exe，小程式不會安裝它。
    const string UpdatePublicKey = "<RSAKeyValue><Modulus>tVzDffWFSdWpzM3O1YJwzkjTgA75R3+GsAm97fXJuE59qO0M3ldv6Xk2YP2Fdg7ysMoy0BOgRWyy19rlEOGmZVGjt6cSN0/Kpi28qNN+fNZYATRfk82gB++03d+2hEk3MHxPliaWYUR0JupFPbxpx2wUWso93+CUBaB+R3Aq07aEWY6OWdNGpNE5M4scNSjRf4UspT26GJLRDjTP8UwUYFoVATcxpCEJsUIDS11v/ctlfTPwetzqmzk3PONu1905AeioBolCPHW23HqfPT+OXZ/5ucA1DPKukcxHdBHWpqoXkoW3ClzTqlxpXyeZfbUJp62L8Kz53Pi+WVpGiv9aFI3EnazY2PjzrG7A5wKxNyNnKEh+3Ok8QWG4W9QMm7Kp1SSmJj9MPC+5eVr67ZeS4qpAsoksY0FeMWguBxuOvZeaI3wl3Y7+giA5uDnhL1NIcNz/NCuhN7ljck+9f1RCm7+2+nBL44xPqXznYqFSU9Pt/7WR76FYoMoHBel/mMyh</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>";
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
    static Mutex Single;

    [STAThread]
    static void Main(string[] args)
    {
        Directory.CreateDirectory(Dir);
        bool first;
        Single = new Mutex(true, "TwPriceOverlay.Singleton", out first);
        // --background：開機自動啟動時用，只在右下角待命，不開小窗（遊戲裡 Ctrl+C 才自動打開）
        bool bg = Array.IndexOf(args, "--background") >= 0;
        if (!first)
        {
            // 已經在執行：只再開一次小窗
            int p;
            Port = int.TryParse(ReadFile("port.txt"), out p) ? p : BasePort;
            if (!bg) OpenWindow(false);
            return;
        }
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        if (!StartServer())
        {
            MessageBox.Show("無法啟動本機服務（連接埠被占用）。", "台服通貨價格", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        File.WriteAllText(Path.Combine(Dir, "port.txt"), Port.ToString());
        CleanupOld();

        Application.EnableVisualStyles();
        var clip = new ClipWatcher();
        Tray = new NotifyIcon();
        Tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Tray.Text = "台服通貨價格 v" + Version + "（遊戲裡 Ctrl+C 查價）";
        var menu = new ContextMenuStrip();
        menu.Items.Add("開啟置頂小窗", null, delegate { OpenWindow(false); });
        menu.Items.Add("開啟完整版面（雙螢幕用）", null, delegate { OpenWindow(true); });
        var top = new ToolStripMenuItem("小窗保持在最上層");
        top.Checked = true;
        top.Click += delegate { KeepTop = !KeepTop; top.Checked = KeepTop; ApplyTop(); };
        menu.Items.Add(top);
        var auto = new ToolStripMenuItem("開機時自動在背景啟動");
        auto.Checked = AutoStart();
        if (auto.Checked) SetAutoStart(true); // exe 搬過位置的話，更新成目前的路徑
        auto.Click += delegate { SetAutoStart(!auto.Checked); auto.Checked = AutoStart(); };
        menu.Items.Add(auto);
        menu.Opening += delegate { auto.Checked = AutoStart(); }; // 小窗裡也能切換，打開選單時同步
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("結束", null, delegate { Tray.Visible = false; Application.Exit(); });
        Tray.ContextMenuStrip = menu;
        Tray.DoubleClick += delegate { OpenWindow(false); };
        Tray.Visible = true;
        Tray.ShowBalloonTip(4000, "台服通貨價格", bg
            ? "已在背景待命。遊戲裡按 Ctrl+C 就會自動開啟小窗顯示價格。"
            : "已啟動。遊戲裡把滑鼠移到物品上按 Ctrl+C，小窗就會顯示價格。右鍵右下角圖示可設定「開機時自動在背景啟動」。", ToolTipIcon.Info);

        if (!bg) OpenWindow(false);
        StartUpdateChecks();
        StartNameLoader();
        Application.Run();
        clip.Dispose();
        GC.KeepAlive(Single);
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
                    // 只有價格表上有的物品（通貨交換能交易的）才自動打開小窗；裝備等其他物品不跳出來擋畫面
                    if (Priced(t)) AutoOpen();
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
                string path = req[1], query = "";
                int q = path.IndexOf('?');
                if (q >= 0) { query = path.Substring(q + 1); path = path.Substring(0, q); }

                if (path == "/app")
                {
                    // 小窗頁面顯示版本、切換「開機時自動在背景啟動」。
                    // 會改設定的請求必須帶自訂標頭 X-TwPrice：瀏覽器不准其他網站對這裡送帶自訂標頭的請求
                    // （要先問過、而這裡不答應），所以惡意網頁無法偷偷替使用者開關自動啟動。
                    bool hdr = false;
                    foreach (var h in lines) if (h.StartsWith("X-TwPrice:", StringComparison.OrdinalIgnoreCase)) hdr = true;
                    if (query == "autostart=1" || query == "autostart=0")
                    {
                        if (!hdr) { Send(s, 403, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("forbidden")); return; }
                        SetAutoStart(query == "autostart=1");
                    }
                    Send(s, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(
                        "{\"version\":\"" + Version + "\",\"autostart\":" + (AutoStart() ? "true" : "false") + "}"));
                }
                else if (path == "/clip")
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

    // ── 自動更新 ─────────────────────────────────────────────
    // 啟動時與之後每 6 小時查網站的 app-version.json；有新版就下載新 exe、核對 SHA-256、替換自己。
    // Windows 不能覆寫執行中的 exe，但可以改名：舊檔改名成 .old，新檔放回原檔名，下次啟動時刪掉 .old。
    // 頁面與價格本來就是從網站即時載入，只有小程式本身的功能改了才需要更新 exe。
    static string ExePath { get { return Application.ExecutablePath; } }
    static bool UpdateReady;

    static void CleanupOld()
    {
        try { if (File.Exists(ExePath + ".old")) File.Delete(ExePath + ".old"); } catch { }
    }

    static void StartUpdateChecks()
    {
        var t = new Thread(delegate ()
        {
            Thread.Sleep(5000); // 先讓小窗開起來
            while (!UpdateReady) { CheckUpdate(); Thread.Sleep(TimeSpan.FromHours(6)); }
        });
        t.IsBackground = true;
        t.Start();
        Tray.BalloonTipClicked += delegate { if (UpdateReady) Restart(); };
    }

    static void CheckUpdate()
    {
        try
        {
            string json;
            using (var w = new WebClient()) { w.Encoding = Encoding.UTF8; json = w.DownloadString(Site + "app-version.json?t=" + DateTime.UtcNow.Ticks); }
            string ver = JsonField(json, "version"), sha = JsonField(json, "sha256"), sig = JsonField(json, "sig");
            Version remote;
            if (sha == null || sig == null || !System.Version.TryParse(ver, out remote) || remote <= new Version(Version)) return;

            byte[] exe;
            using (var w = new WebClient()) exe = w.DownloadData(Site + "TwPriceOverlay.exe?t=" + DateTime.UtcNow.Ticks);
            string got;
            using (var h = System.Security.Cryptography.SHA256.Create()) got = BitConverter.ToString(h.ComputeHash(exe)).Replace("-", "").ToLowerInvariant();
            if (got != sha.ToLowerInvariant()) return; // 下載不完整或內容不符：不使用，下次再試
            if (!SignatureOk(exe, sig)) return;         // 簽章不符：可能被竄改，絕不安裝

            try
            {
                File.WriteAllBytes(ExePath + ".new", exe);
                if (File.Exists(ExePath + ".old")) File.Delete(ExePath + ".old");
                File.Move(ExePath, ExePath + ".old");
                File.Move(ExePath + ".new", ExePath);
            }
            catch
            {
                try { if (File.Exists(ExePath + ".new")) File.Delete(ExePath + ".new"); } catch { }
                Tray.ShowBalloonTip(8000, "台服通貨價格 有新版 v" + ver, "無法自動更新（這個資料夾不能寫入），請到網站重新下載。", ToolTipIcon.Warning);
                UpdateReady = true; // 不再重試
                return;
            }
            UpdateReady = true;
            Tray.ShowBalloonTip(10000, "台服通貨價格 已更新到 v" + ver, "點這裡立即重新啟動；或下次開啟時自動使用新版。", ToolTipIcon.Info);
        }
        catch { } // 沒網路之類：下次再試
    }

    static void Restart()
    {
        Tray.Visible = false;
        // 先放掉「只能開一個」的鎖，新版才不會以為已經有一份在跑而直接結束
        try { Single.ReleaseMutex(); Single.Dispose(); } catch { }
        Process.Start(ExePath, "--restart");
        Environment.Exit(0);
    }

    // 用內建公鑰驗證發布者的簽章（RSA、SHA-256、PKCS#1 v1.5，對應 sign-exe.ps1）
    static bool SignatureOk(byte[] data, string sigBase64)
    {
        try
        {
            using (var rsa = new System.Security.Cryptography.RSACryptoServiceProvider())
            {
                rsa.PersistKeyInCsp = false;
                rsa.FromXmlString(UpdatePublicKey);
                return rsa.VerifyData(data, System.Security.Cryptography.CryptoConfig.MapNameToOID("SHA256"), Convert.FromBase64String(sigBase64));
            }
        }
        catch { return false; }
    }

    // 只讀扁平 JSON 的字串欄位（app-version.json 只有兩個欄位，不值得引入 JSON 函式庫）
    static string JsonField(string json, string name)
    {
        var m = Regex.Match(json, "\"" + name + @"""\s*:\s*""([^""]*)""");
        return m.Success ? m.Groups[1].Value : null;
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

    // ── 開機自動啟動（只寫目前使用者的登錄，不需要系統管理員權限）─────
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    static bool AutoStart()
    {
        using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey)) return k != null && k.GetValue("TwPriceOverlay") != null;
    }
    static void SetAutoStart(bool on)
    {
        using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (on) k.SetValue("TwPriceOverlay", "\"" + Application.ExecutablePath + "\" --background");
            else k.DeleteValue("TwPriceOverlay", false);
        }
    }

    // 價格表上的物品名稱（中文、英文），從網站的 data.js 取出；啟動時讀一次，之後每 30 分鐘更新
    static HashSet<string> Names = new HashSet<string>();
    static readonly Regex NameRe = new Regex("\"(?:name|en)\":\"([^\"]+)\"");
    static string Norm(string s) { return s.Replace("汙", "污").Trim(); }
    static void StartNameLoader()
    {
        var t = new Thread(delegate ()
        {
            while (true)
            {
                try
                {
                    string js = Encoding.UTF8.GetString(Proxy("data.js"));
                    var set = new HashSet<string>();
                    foreach (Match m in NameRe.Matches(js)) set.Add(Norm(m.Groups[1].Value));
                    if (set.Count > 100) lock (Lk) Names = set; // 抓失敗（內容太少）就沿用上一份
                }
                catch { }
                Thread.Sleep(30 * 60 * 1000);
            }
        });
        t.IsBackground = true;
        t.Start();
    }
    // 物品名稱在「稀有度」那一行之後、第一條分隔線之前（稀有裝備會有兩行：名稱＋基底）
    static bool Priced(string text)
    {
        HashSet<string> names;
        lock (Lk) names = Names;
        bool after = false;
        foreach (string raw in text.Split('\n'))
        {
            string line = raw.Trim();
            if (!after) { after = ItemLike.IsMatch(line); continue; }
            if (line.StartsWith("--")) break;
            if (line.Length > 0 && names.Contains(Norm(line))) return true;
        }
        return false;
    }

    // 複製到遊戲物品、但小窗（或完整版面）沒開：自動打開。
    // 瀏覽器開窗要幾秒，10 秒內不重複開，避免連按 Ctrl+C 開出好幾個視窗。新開的頁面會自己讀到剛才複製的物品。
    static long LastOpen;
    static void AutoOpen()
    {
        long now = DateTime.UtcNow.Ticks / 10000;
        if (now - LastOpen < 10000 || WindowOpen()) return;
        LastOpen = now;
        IntPtr game = GetForegroundWindow();
        OpenWindow(false);
        // 瀏覽器開窗會搶走鍵盤焦點，之後在遊戲裡按 Ctrl+C 會送到小窗、遊戲沒有複製。
        // 等小窗出現後把焦點還給剛才的視窗（遊戲），下一次 Ctrl+C 才查得到
        var t = new Thread(delegate ()
        {
            for (int i = 0; i < 50 && !WindowOpen(); i++) Thread.Sleep(200);
            // 瀏覽器載入頁面時可能再搶一次焦點，所以接下來 5 秒內持續檢查、被搶走就還回去
            for (int i = 0; i < 20; i++) { Thread.Sleep(250); GiveFocus(game); }
        });
        t.IsBackground = true;
        t.Start();
    }
    // Windows 不讓背景程式隨便切換前景視窗；暫時把輸入接到目前前景視窗的執行緒上，切換才會生效
    static void GiveFocus(IntPtr h)
    {
        if (h == IntPtr.Zero) return;
        IntPtr fg = GetForegroundWindow();
        if (fg == h) return;
        uint pid;
        uint fgThread = GetWindowThreadProcessId(fg, out pid), me = GetCurrentThreadId();
        bool attached = fgThread != me && AttachThreadInput(me, fgThread, true);
        SetForegroundWindow(h);
        if (attached) AttachThreadInput(me, fgThread, false);
        if (GetForegroundWindow() != h)
        {
            // 還是被擋：按放一下 Alt（Windows 允許剛有鍵盤輸入的程式切換前景），再切一次
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(h);
        }
    }
    static bool WindowOpen()
    {
        bool found = false;
        EnumWindows(delegate (IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, 256);
            string t = sb.ToString();
            if (t.Contains("疊加") || t == "台服通貨價格") { found = true; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static void OpenWindow(bool wide)
    {
        LastOpen = DateTime.UtcNow.Ticks / 10000;
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

    // 遊戲（視窗化全螢幕）被點回前景時會蓋過小窗，所以持續每 1.5 秒把小窗放回最上層。
    // SWP_NOACTIVATE：只改上下順序，不搶遊戲的焦點。只啟動一次。
    static bool TopStarted;
    static void StartTopThread()
    {
        if (TopStarted) return;
        TopStarted = true;
        var t = new Thread(delegate () { while (true) { Thread.Sleep(1500); if (KeepTop) ApplyTop(); } });
        t.IsBackground = true;
        t.Start();
    }

    // ── 置頂 ─────────────────────────────────────────────────
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
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
