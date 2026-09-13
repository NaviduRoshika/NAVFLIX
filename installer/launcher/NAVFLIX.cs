// NAVFLIX.exe: the icon you double-click.
//
// NAVFLIX is a small web server plus a page. Started from a console window,
// closing the console stopped it. Started from an icon there is no console, so
// this does the console's job:
//
//   1. Start the server hidden, or find the one already running from this folder.
//   2. Open NAVFLIX in a window of its own: Edge, or Chrome, in app mode, with a
//      profile of its own so it is not mixed in with everyday browsing.
//   3. When every NAVFLIX window has closed, ask the server to stop. A film still
//      playing in VLC is let finish first, so its position is saved.
//
// Built with the C# compiler that ships with Windows (.NET Framework 4), so it
// needs nothing installed. That compiler speaks C# 5: no string interpolation,
// no ?. operator.
//
//   NAVFLIX.exe          open NAVFLIX
//   NAVFLIX.exe --quit   stop a running NAVFLIX now (the installer uses this)

using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("NAVFLIX")]
[assembly: System.Reflection.AssemblyProduct("NAVFLIX")]
[assembly: System.Reflection.AssemblyDescription("Opens NAVFLIX, and stops it when its window is closed")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

static class Launcher
{
    // Every NAVFLIX window is started with this in its command line (it is the
    // name of the window's profile folder), which is how its processes are told
    // apart from anything else the browser has open.
    const string WindowMark = "navflix-app-window";

    static string Root, DataDir, RunningFile, LogFile;

    class Running
    {
        public int Port;
        public int Pid;
        public string Instance;
        public string Url;   // what the window opens
        public string Api;   // what this launcher talks to: 127.0.0.1, never a lookup of "localhost"
    }

    [STAThread]
    static int Main(string[] args)
    {
        Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        DataDir = Path.Combine(Root, "data");
        RunningFile = Path.Combine(DataDir, "running.json");
        LogFile = Path.Combine(DataDir, "navflix.log");
        try { Directory.CreateDirectory(DataDir); } catch (Exception) { }

        foreach (string a in args)
            if (a == "--quit") return QuitRunning();

        try { return Open(); }
        catch (Exception ex)
        {
            Fail("Something went wrong opening NAVFLIX.\n\n" + ex.Message);
            return 1;
        }
    }

    static int Open()
    {
        Running run = null;
        Process server = null;

        // One launcher at a time gets to find or start the server, so two quick
        // double-clicks cannot start two. Held only for that part; the windows
        // are then waited on side by side.
        using (Mutex gate = new Mutex(false, "Local\\NAVFLIX-" + Hash(Root.ToLowerInvariant())))
        {
            bool held = false;
            try { held = gate.WaitOne(TimeSpan.FromSeconds(90)); }
            catch (AbandonedMutexException) { held = true; }
            try
            {
                run = FindRunning();
                if (run != null)
                {
                    // Opened again while it was waiting for a film to end before
                    // stopping: it is wanted after all, so it stays.
                    Post(run.Api + "/api/quit", "{\"cancel\":true}");
                }
                else
                {
                    server = StartServer();
                    if (server == null) return 1;
                    run = WaitForServer(server);
                    if (run == null)
                    {
                        try { if (!server.HasExited) server.Kill(); } catch (Exception) { }
                        Fail("NAVFLIX did not start.");
                        return 1;
                    }
                }
            }
            finally { if (held) gate.ReleaseMutex(); }
        }

        string browser = FindBrowser();
        Process window = browser == null ? null : OpenWindow(browser, run.Url);
        if (window == null || !WaitForWindows(window))
        {
            // No Edge or Chrome to make an app window with, so an ordinary browser
            // tab it is. There is no telling when a tab closes; the server stops
            // itself once nothing has looked at it for a while.
            try { Process.Start(run.Url); } catch (Exception) { }
            return 0;
        }

        string answer = Post(run.Api + "/api/quit", "{}");
        if (server != null && answer != null && answer.Contains("\"waitingForPlayback\":false"))
        {
            try { if (!server.WaitForExit(15000)) server.Kill(); } catch (Exception) { }
        }
        return 0;
    }

    // The server writes data\running.json once it is listening. A file left behind
    // by a crash is not trusted: the port has to answer, and answer as that run.
    static Running FindRunning()
    {
        string text;
        try { text = File.ReadAllText(RunningFile); } catch (Exception) { return null; }

        Match port = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
        Match inst = Regex.Match(text, "\"instance\"\\s*:\\s*\"([0-9a-f]+)\"");
        Match pid = Regex.Match(text, "\"pid\"\\s*:\\s*(\\d+)");
        if (!port.Success || !inst.Success) return null;

        Running r = new Running();
        r.Port = int.Parse(port.Groups[1].Value);
        r.Instance = inst.Groups[1].Value;
        r.Pid = pid.Success ? int.Parse(pid.Groups[1].Value) : 0;
        r.Url = "http://localhost:" + r.Port;
        r.Api = "http://127.0.0.1:" + r.Port;

        string who = Http("GET", r.Api + "/api/whoami", null);
        if (who == null || who.IndexOf(r.Instance, StringComparison.Ordinal) < 0) return null;
        return r;
    }

    static Process StartServer()
    {
        string node = Path.Combine(Root, @"runtime\node\node.exe");
        if (!File.Exists(node)) node = "node";

        TrimLog();
        try
        {
            File.AppendAllText(LogFile, Environment.NewLine + "---- " +
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " opened from the icon" + Environment.NewLine);
        }
        catch (Exception) { }

        ProcessStartInfo psi = new ProcessStartInfo(node, "server.js");
        psi.WorkingDirectory = Root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        // There is no console, so the server writes what it would have printed
        // into the log itself. Not through a pipe from here: this launcher exits
        // while a film is still playing, and the server must outlive it.
        psi.EnvironmentVariables["NAVFLIX_LOG"] = LogFile;
        psi.EnvironmentVariables["NAVFLIX_LAUNCHER"] = "1";
        psi.EnvironmentVariables["NO_OPEN"] = "1";
        try { return Process.Start(psi); }
        catch (Exception ex)
        {
            Fail("NAVFLIX could not start.\n\n" + ex.Message);
            return null;
        }
    }

    static Running WaitForServer(Process server)
    {
        // Listening takes a second or two. Reading a big library happens after
        // that, so this is not a wait on the library.
        DateTime until = DateTime.Now.AddSeconds(90);
        while (DateTime.Now < until)
        {
            Running r = FindRunning();
            if (r != null) return r;
            if (server.HasExited)
            {
                // It may have stepped aside for a copy that was already running.
                Thread.Sleep(600);
                return FindRunning();
            }
            Thread.Sleep(250);
        }
        return null;
    }

    static string FindBrowser()
    {
        string chosen = Environment.GetEnvironmentVariable("NAVFLIX_BROWSER");
        if (!string.IsNullOrEmpty(chosen) && File.Exists(chosen)) return chosen;

        foreach (string exe in new string[] { "msedge.exe", "chrome.exe" })
        {
            foreach (RegistryKey hive in new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                try
                {
                    using (RegistryKey k = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                    {
                        string v = k == null ? null : k.GetValue("") as string;
                        if (!string.IsNullOrEmpty(v))
                        {
                            v = v.Trim('"');
                            if (File.Exists(v)) return v;
                        }
                    }
                }
                catch (Exception) { }
            }
        }

        string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "";
        string pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? "";
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] guesses = {
            Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(local, @"Google\Chrome\Application\chrome.exe"),
        };
        foreach (string g in guesses)
            if (File.Exists(g)) return g;
        return null;
    }

    static Process OpenWindow(string browser, string url)
    {
        string profile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NAVFLIX", WindowMark);
        string args = "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\"" +
            " --no-first-run --no-default-browser-check --window-size=1440,900";
        try { return Process.Start(browser, args); }
        catch (Exception) { return null; }
    }

    // True once every NAVFLIX window has closed; false if none ever opened.
    //
    // Watching the process that was started is not enough. If a NAVFLIX window
    // is already open, the browser hands the new one to that process and the one
    // started here exits at once. So the browser processes carrying the window's
    // profile are counted instead, however they came to be.
    static bool WaitForWindows(Process started)
    {
        bool seen = false;
        for (int i = 0; i < 60 && !seen; i++)
        {
            int n = CountWindowProcesses();
            if (n < 0) { WaitQuietly(started); return true; }   // no process list: watch what we have
            seen = n > 0;
            if (!seen) Thread.Sleep(500);
        }
        if (!seen) return false;

        int emptyPolls = 0;
        while (emptyPolls < 2)
        {
            Thread.Sleep(1500);
            int n = CountWindowProcesses();
            if (n < 0) { WaitQuietly(started); return true; }
            emptyPolls = n == 0 ? emptyPolls + 1 : 0;
        }
        return true;
    }

    static void WaitQuietly(Process p)
    {
        try { p.WaitForExit(); } catch (Exception) { }
    }

    static int CountWindowProcesses()
    {
        try
        {
            int self = Process.GetCurrentProcess().Id;
            int n = 0;
            string query = "SELECT ProcessId FROM Win32_Process WHERE CommandLine LIKE '%" + WindowMark + "%'";
            using (ManagementObjectSearcher search = new ManagementObjectSearcher(query))
            using (ManagementObjectCollection found = search.Get())
            {
                foreach (ManagementBaseObject o in found)
                    if (Convert.ToInt32(o["ProcessId"]) != self) n++;
            }
            return n;
        }
        catch (Exception) { return -1; }
    }

    static int QuitRunning()
    {
        Running r = FindRunning();
        if (r == null) return 0;
        Http("POST", r.Api + "/api/quit", "{\"force\":true}");
        try
        {
            if (r.Pid > 0)
            {
                Process p = Process.GetProcessById(r.Pid);
                if (!p.WaitForExit(10000)) p.Kill();
            }
        }
        catch (Exception) { }
        return 0;
    }

    static string Post(string url, string json)
    {
        return Http("POST", url, json);
    }

    static string Http(string method, string url, string body)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Proxy = null;          // a system proxy has no business between us and our own server
            req.Timeout = 3000;
            req.ReadWriteTimeout = 3000;
            if (body != null)
            {
                byte[] data = Encoding.UTF8.GetBytes(body);
                req.ContentType = "application/json";
                req.ContentLength = data.Length;
                using (Stream s = req.GetRequestStream()) s.Write(data, 0, data.Length);
            }
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader rd = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                return rd.ReadToEnd();
        }
        catch (Exception) { return null; }
    }

    // A log that grows for years helps nobody. Past a megabyte, keep the end.
    static void TrimLog()
    {
        try
        {
            FileInfo f = new FileInfo(LogFile);
            if (!f.Exists || f.Length < 1024 * 1024) return;
            byte[] all = File.ReadAllBytes(LogFile);
            int keep = 256 * 1024;
            byte[] tail = new byte[keep];
            Array.Copy(all, all.Length - keep, tail, 0, keep);
            File.WriteAllBytes(LogFile, tail);
        }
        catch (Exception) { }
    }

    static void Fail(string message)
    {
        string tail = "";
        try
        {
            string[] lines = File.ReadAllLines(LogFile);
            int from = Math.Max(0, lines.Length - 8);
            if (lines.Length > 0)
                tail = "\n\nThe last lines of the log:\n" + string.Join("\n", lines, from, lines.Length - from);
        }
        catch (Exception) { }
        MessageBox.Show(message + tail + "\n\nThe full log is " + LogFile,
            "NAVFLIX", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    static string Hash(string s)
    {
        using (SHA1 sha = SHA1.Create())
        {
            byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < 8; i++) b.Append(h[i].ToString("x2"));
            return b.ToString();
        }
    }
}
