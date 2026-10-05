import AppKit

// Code Sonata menu bar indicator. Reads ~/Library/Caches/code-sonata/status.json
// (written every second by agents.py) and drops commands into ".../commands".
// Turning the music on/off goes through the shared control.py helper.

let cache = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/code-sonata")
let statusFile = cache.appendingPathComponent("status.json")
let commandFile = cache.appendingPathComponent("commands")
let control = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".codex/skills/code-sonata/scripts/control.py").path

struct Status: Decodable {
    let updated: Double
    let muted: Bool
    let playing: Bool
    let sessions: Int
    let voices: [String]
    let bpm: Int
    let song: String
    let intensity: Double?
    let climax: Bool?
}

final class Indicator: NSObject, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var status: Status?

    override init() {
        super.init()
        item.menu = NSMenu()
        item.menu?.delegate = self
        refresh()
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func load() -> Status? {
        guard let data = try? Data(contentsOf: statusFile),
              let status = try? JSONDecoder().decode(Status.self, from: data),
              Date().timeIntervalSince1970 - status.updated < 5 else { return nil }
        return status
    }

    func refresh() {
        status = load()
        let title: String
        if let s = status {
            let heat = (s.climax ?? false) ? " 🔥" : ((s.intensity ?? 0) > 0.5 ? " ⚡" : "")
            title = s.muted ? "♪ sessiz" : (s.playing ? "♫ \(max(1, s.sessions))\(heat)" : "♪")
        } else {
            title = "♪ kapalı"
        }
        item.button?.title = title
        item.button?.toolTip = "Code Sonata"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        func info(_ text: String) {
            let entry = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            entry.isEnabled = false
            menu.addItem(entry)
        }
        func action(_ text: String, _ selector: Selector) {
            let entry = NSMenuItem(title: text, action: selector, keyEquivalent: "")
            entry.target = self
            menu.addItem(entry)
        }
        if let s = load() {
            info("Code Sonata · \(s.song)")
            info(s.sessions == 0 ? "Çalışan Claude yok, sessiz bekliyor" : "\(s.sessions) oturum · \(s.bpm) BPM · heyecan %\(Int((s.intensity ?? 0) * 100))")
            if !s.voices.isEmpty { info(s.voices.joined(separator: ", ")) }
            menu.addItem(.separator())
            action(s.muted ? "Sesi aç" : "Sesi kapat", #selector(toggleMute))
            action("Sonraki şarkı", #selector(nextSong))
            action("Müziği kapat", #selector(stopMusic))
        } else {
            info("Code Sonata kapalı")
            menu.addItem(.separator())
            action("Müziği aç", #selector(startMusic))
        }
        menu.addItem(.separator())
        action("Göstergeyi gizle", #selector(quit))
    }

    func send(_ command: String) {
        // Append so two quick clicks are not lost; agents.py consumes and deletes.
        if let handle = try? FileHandle(forWritingTo: commandFile) {
            handle.seekToEndOfFile()
            handle.write((command + "\n").data(using: .utf8)!)
            try? handle.close()
        } else {
            try? (command + "\n").write(to: commandFile, atomically: true, encoding: .utf8)
        }
    }

    func run(_ argument: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [control, argument]
        try? process.run()
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.refresh() } }
    }

    @objc func toggleMute() { send("toggle") }
    @objc func nextSong() { send("next") }
    @objc func startMusic() { run("start") }
    @objc func stopMusic() { run("stop") }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // menu bar only, no Dock icon
let indicator = Indicator()
app.run()
