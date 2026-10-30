import AppKit

// Code Sonata menu bar indicator. Reads ~/Library/Caches/code-sonata/status.json
// (written every second by agents.py) and drops commands into ".../commands".
// Turning the music on/off goes through the shared control.py helper: control.py passes its own path
// (CODE_SONATA_CONTROL) when it starts this indicator; otherwise it is looked up next to the binary.

let cache = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/code-sonata")
let statusFile = cache.appendingPathComponent("status.json")
let commandFile = cache.appendingPathComponent("commands")
let control = ProcessInfo.processInfo.environment["CODE_SONATA_CONTROL"]
    ?? (Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0]))
        .resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("skill/scripts/control.py").path

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
    let style: String?          // the arrangement now playing
    let choice: String?         // "karisik", "sira", "akis" (loops instead of songs) or one song's id
    let flow: Bool?             // loops are playing: no song to like, ban or queue
    let styles: [[String]]?     // [id, title]
    let library: [[String]]?    // [id, title]: the repertoire plus songs imported on this Mac
    let melody: String?         // how much melody: az, orta, cok
    let volume: Int?            // master level 0-100
    let liked: Bool?            // the song now playing is liked
    let queue: [[String]]?      // [id, title]: the user's own order
    let quiet: [String]?        // signals turned off
    let signals: [[String]]?    // [kind, name]
}

final class Indicator: NSObject, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var status: Status?
    var failure: String?   // the last start/stop error, shown in the menu instead of failing silently
    var offSince: Date?    // music off since; after two minutes the indicator quits (it costs ~40 MB)

    override init() {
        super.init()
        item.menu = NSMenu()
        item.menu?.delegate = self
        item.button?.toolTip = "Code Sonata"
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
            offSince = offSince ?? Date()
            if Date().timeIntervalSince(offSince!) > 120 { NSApp.terminate(nil) }   // control.py start brings it back
        }
        if status != nil { offSince = nil }
        if item.button?.title != title { item.button?.title = title }   // redraw only on a change
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
        if let failure = failure { info("Hata: \(failure)") }
        if let s = load() {
            info("Code Sonata · \(s.song)")
            info(s.sessions == 0 ? "Çalışan Claude yok, sessiz bekliyor" : "\(s.sessions) oturum · \(s.bpm) BPM · heyecan %\(Int((s.intensity ?? 0) * 100))")
            if !s.voices.isEmpty { info(s.voices.joined(separator: ", ")) }
            menu.addItem(.separator())
            action(s.muted ? "Sesi aç" : "Sesi kapat", #selector(toggleMute))
            action(s.flow == true ? "Sonraki sahne" : "Sonraki şarkı", #selector(nextSong))
            // This song: liked songs come first in their mood; a banned one leaves the mix at once.
            if s.flow != true {
                action(s.liked == true ? "♥ Sevdim (geri al)" : "♡ Sevdim", #selector(like))
                action("Bu şarkıyı çalma", #selector(ban))
                action("Sıraya ekle", #selector(enqueue))
            }
            // Pick a style or a song while it plays; the choice is remembered for the next start.
            func picker(_ title: String, _ rows: [[String]], _ current: String?, _ prefix: String) {
                let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                let sub = NSMenu()
                for row in rows where row.count == 2 {
                    let item = NSMenuItem(title: row[1], action: #selector(pick(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = prefix + row[0]
                    item.state = row[0] == current ? .on : .off
                    sub.addItem(item)
                }
                entry.submenu = sub
                menu.addItem(entry)
            }
            if let styles = s.styles { picker("Stil", styles, s.style, "style:") }
            let queue = s.queue ?? []
            let mine = queue.isEmpty ? [] : [["sira", "Sıram (\(queue.count) şarkı)"]]
            if let library = s.library { picker("Şarkı", [["akis", "Akış (katmanlı döngüler)"], ["karisik", "Karışık (tempoya göre)"]] + mine + library, s.choice, "song:") }
            picker("Melodi", [["az", "Az (bol ara)"], ["orta", "Orta"], ["cok", "Çok (arasız)"]], s.melody ?? "orta", "melody:")
            picker("Ses", [["30", "%30"], ["50", "%50"], ["70", "%70"], ["100", "%100"]], String(s.volume ?? 100), "volume:")
            if let signals = s.signals {   // each one on or off; the harmony still follows the tests
                let entry = NSMenuItem(title: "Sinyaller", action: nil, keyEquivalent: "")
                let sub = NSMenu()
                for row in signals where row.count == 2 {
                    let item = NSMenuItem(title: row[1], action: #selector(pick(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = "signal:" + row[0]
                    item.state = (s.quiet ?? []).contains(row[0]) ? .off : .on
                    sub.addItem(item)
                }
                entry.submenu = sub
                menu.addItem(entry)
            }
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
        let process = Process(), errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [control, argument]
        process.standardError = errors
        process.terminationHandler = { [weak self] finished in
            let text = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                self?.failure = finished.terminationStatus == 0 ? nil
                    : String(text.split(separator: "\n").last ?? "çıkış kodu \(finished.terminationStatus)").prefix(120).description
                self?.refresh()
            }
        }
        do { try process.run() } catch { failure = "\(control) açılamadı" }
    }

    @objc func pick(_ sender: NSMenuItem) {
        if let command = sender.representedObject as? String { send(command) }
    }
    @objc func toggleMute() { send("toggle") }
    @objc func nextSong() { send("next") }
    @objc func like() { send("like") }
    @objc func ban() { send("ban") }
    @objc func enqueue() { send("enqueue") }
    @objc func startMusic() { run("start") }
    @objc func stopMusic() { run("stop") }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // menu bar only, no Dock icon
let indicator = Indicator()
app.run()
