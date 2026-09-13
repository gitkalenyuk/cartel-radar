// Cartel Radar — нативна обгортка для macOS (WKWebView + локальний Node-сервер)
// Компілюється swiftc, без зовнішніх залежностей.

import Cocoa
import WebKit
import Darwin

let kDefaultPort = 8787
let kPortRange = 8787...8800

let logURL: URL = {
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("CartelRadar.log")
}()

func logLine(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = stamp + "  " + s + "\n"
    if let h = try? FileHandle(forWritingTo: logURL) {
        h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close()
    } else {
        try? line.write(to: logURL, atomically: true, encoding: .utf8)
    }
}

func findNode() -> String? {
    let home = NSHomeDirectory()
    var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/opt/local/bin/node"]
    // nvm
    let nvm = home + "/.nvm/versions/node"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
        for v in versions.sorted().reversed() { candidates.append(nvm + "/" + v + "/bin/node") }
    }
    candidates.append(home + "/.volta/bin/node")
    candidates.append(home + "/.local/bin/node")
    for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }
    // остання спроба — через оболонку
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = ["-lc", "command -v node"]
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
    try? p.run(); p.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let o = out, !o.isEmpty, FileManager.default.isExecutableFile(atPath: o) { return o }
    return nil
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var child: Process?
    var baseURL: URL?
    var signalSources: [DispatchSourceSignal] = []

    // щоб сервер зупинявся навіть при kill з термінала чи Activity Monitor
    func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in
                logLine("отримано сигнал — завершуюсь")
                self?.stopServer()
                NSApp.terminate(nil)
            }
            src.resume()
            signalSources.append(src)
        }
    }

    func stopServer() {
        guard let c = child, c.isRunning else { return }
        if let url = baseURL { requestShutdown(url) }
        c.terminate()
        let deadline = Date().addingTimeInterval(2.5)
        while c.isRunning && Date() < deadline { usleep(80_000) }
        if c.isRunning { kill(c.processIdentifier, SIGKILL) }
        child = nil
    }

    // ---------------------------------------------------------------- lifecycle
    func applicationDidFinishLaunching(_ note: Notification) {
        installSignalHandlers()
        buildMenu()
        buildWindow()
        boot()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) {
        logLine("завершення застосунку")
        stopServer()
    }

    // ---------------------------------------------------------------- menu
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Про Cartel Radar", action: #selector(orderAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Перезавантажити сторінку", action: #selector(reloadPage), keyEquivalent: "r")
        appMenu.addItem(withTitle: "Відкрити в браузері", action: #selector(openInBrowser), keyEquivalent: "b")
        appMenu.addItem(withTitle: "Тека з даними", action: #selector(openDataFolder), keyEquivalent: "d")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Збільшити", action: #selector(zoomIn), keyEquivalent: "+")
        appMenu.addItem(withTitle: "Зменшити", action: #selector(zoomOut), keyEquivalent: "-")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Сховати Cartel Radar", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Завершити Cartel Radar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Правка")
        edit.addItem(withTitle: "Вставити", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Копіювати", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Вирізати", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Виділити все", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "Вигляд")
        view.addItem(withTitle: "На весь екран", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = view
        NSApp.mainMenu = main
    }

    @objc func orderAbout() { NSApp.orderFrontStandardAboutPanel(nil) }
    @objc func reloadPage() { webView.reload() }
    @objc func openInBrowser() { if let u = baseURL { NSWorkspace.shared.open(u) } }
    @objc func openDataFolder() {
        let dir = Bundle.main.resourceURL!.appendingPathComponent("app/data")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)
    }
    @objc func zoomIn() { webView.pageZoom = min(2.0, webView.pageZoom + 0.1) }
    @objc func zoomOut() { webView.pageZoom = max(0.5, webView.pageZoom - 0.1) }

    // ---------------------------------------------------------------- window
    func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1500, height: 950)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Cartel Radar"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.minSize = NSSize(width: 1080, height: 680)
        window.center()
        window.backgroundColor = NSColor(calibratedRed: 0.03, green: 0.045, blue: 0.075, alpha: 1)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        logLine("вікно створено")
        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView(frame: rect)
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        showSplash("Запускаю локальний сервер…")
    }

    func showSplash(_ message: String) {
        let html = "<!doctype html><meta charset='utf-8'><style>body{margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,#0d1728,#05070d 70%);color:#eaf0ff;font:15px -apple-system,system-ui,sans-serif}" +
        ".w{text-align:center}.r{width:74px;height:74px;margin:0 auto 20px;border-radius:50%;border:2px solid rgba(182,255,61,.25);border-top-color:#b6ff3d;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}" +
        "h1{font-size:21px;margin:0 0 8px;letter-spacing:-.4px}p{color:#8b98b8;margin:0}</style>" +
        "<div class='w'><div class='r'></div><h1>Cartel Radar</h1><p>" + message + "</p></div>"
        webView.loadHTMLString(html, baseURL: nil)
    }

    func showFatal(_ title: String, _ message: String) {
        let html = "<!doctype html><meta charset='utf-8'><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#05070d;color:#eaf0ff;font:15px -apple-system,system-ui,sans-serif}" +
        ".w{max-width:560px;text-align:center;padding:30px}h1{font-size:22px;color:#ffb3c1;margin:0 0 14px}p{color:#8b98b8;line-height:1.6}" +
        "code{background:#101a2e;padding:3px 7px;border-radius:6px;color:#b6ff3d}</style>" +
        "<div class='w'><h1>" + title + "</h1><p>" + message + "</p></div>"
        webView.loadHTMLString(html, baseURL: nil)
    }

    // ---------------------------------------------------------------- server
    func boot() {
        logLine("boot(): старт")
        probe(port: kDefaultPort) { alive in
            if alive {
                logLine("знайдено вже запущений сервер на порту " + String(kDefaultPort))
                self.loadApp(port: kDefaultPort)
                return
            }
            self.spawnServer()
        }
    }

    func loadApp(port: Int) {
        guard let url = URL(string: "http://127.0.0.1:" + String(port) + "/") else { return }
        baseURL = url
        logLine("завантажую інтерфейс: " + url.absoluteString)
        webView.load(URLRequest(url: url))
    }

    // перевірка живого сервера без блокування головного потоку
    func probe(port: Int, done: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:" + String(port) + "/api/health") else { return done(false) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { data, _, error in
            if let e = error { logLine("health " + String(port) + ": " + e.localizedDescription) }
            let ok = (data.flatMap { String(data: $0, encoding: .utf8) } ?? "").contains("\"ok\":true")
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func spawnServer() {
        guard let node = findNode() else {
            logLine("Node.js не знайдено")
            showFatal("Не знайдено Node.js",
                      "Застосунок працює на Node.js. Встановіть LTS-версію з <code>nodejs.org</code> або виконайте <code>brew install node</code>, тоді відкрийте Cartel Radar знову.")
            return
        }
        logLine("node: " + node)
        let resDir = Bundle.main.resourceURL ?? Bundle.main.bundleURL.appendingPathComponent("Contents/Resources")
        let appDir = resDir.appendingPathComponent("app")
        logLine("тека застосунку: " + appDir.path)
        guard FileManager.default.fileExists(atPath: appDir.appendingPathComponent("server.mjs").path) else {
            logLine("немає server.mjs у " + appDir.path)
            showFatal("Пошкоджена інсталяція", "Усередині застосунку немає серверних файлів. Перевстановіть Cartel Radar.")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["server.mjs", "--port", String(kDefaultPort)]
        p.currentDirectoryURL = appDir
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        env["CARTEL_RADAR_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        // ключі й ніші — у постійній теці, щоб оновлення застосунку їх не стирало
        let support = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CartelRadar/data")
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        env["CARTEL_RADAR_DATA"] = support.path
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { fh in
            let chunk = fh.availableData
            if chunk.isEmpty { return }
            logLine("сервер: " + (String(data: chunk, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        }
        do { try p.run(); logLine("node запущено, pid " + String(p.processIdentifier)) }
        catch {
            logLine("не вдалося запустити node: " + error.localizedDescription)
            showFatal("Не вдалося запустити сервер", error.localizedDescription)
            return
        }
        child = p
        waitForServer(port: kDefaultPort, attempts: 60)
    }

    // чекаємо, поки сервер підніметься, і лише тоді показуємо інтерфейс
    func waitForServer(port: Int, attempts: Int) {
        probe(port: port) { ok in
            if ok { self.loadApp(port: port); return }
            if attempts <= 0 {
                logLine("сервер не піднявся")
                self.showFatal("Сервер не відповідає", "Локальний сервер не запустився. Закрийте застосунок і відкрийте знову, або запустіть <code>launch.command</code> у теці CartelRadar.")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitForServer(port: port, attempts: attempts - 1) }
        }
    }

    func requestShutdown(_ url: URL) {
        guard let target = URL(string: url.absoluteString + "api/shutdown") else { return }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.timeoutInterval = 1.5
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 1.6)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }

    // ---------------------------------------------------------------- web policy
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        let host = url.host ?? ""
        if host == "127.0.0.1" || host == "localhost" || url.scheme == "about" || host.isEmpty {
            return decisionHandler(.allow)
        }
        NSWorkspace.shared.open(url)          // зовнішні посилання — у браузер
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        logLine("navigation failed: " + error.localizedDescription)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
