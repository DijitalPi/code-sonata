import Foundation
import AVFoundation

// One sampler per voice (General MIDI program). Commands on stdin:
//   "<note> <velocity> <seconds> [voice] [delay ms]"   voice defaults to 0 (piano), delay to 0
//   "quiet"
//   "program <voice> <gm program>"   another instrument for a voice (a style); for voice 10, a drum kit
//   "stats"   prints how late scheduled notes started: "STATS <count> <mean ms> <max ms>"
//   "volume <0-100>"   master volume; 100 is the default level
// A delay lets the caller send notes a little early with their exact time: a strict timer starts
// them on the beat, so the caller's own loop timing does not shake the rhythm.
// All MIDI operations are serialized. Generations protect repeated notes
// from an earlier note's delayed release.
// piano, strings, choir, cello, flute, vibraphone, horn, harp, timpani, tremolo strings, drum kit, accordion
let programs: [UInt8] = [0, 48, 52, 42, 73, 11, 60, 46, 47, 44, 0, 21]
let percussion: Set<Int> = [10]
let system = URL(fileURLWithPath: "/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls")
// SONATA_SOUNDFONT, or ~/Library/Application Support/code-sonata/soundfont.sf2 when present, replaces
// the system's General MIDI set (for example FluidR3_GM, the set the Agent Orchestra site plays).
let custom: URL? = {
    if let path = ProcessInfo.processInfo.environment["SONATA_SOUNDFONT"], !path.isEmpty {
        return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    }
    let fallback = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/code-sonata/soundfont.sf2")
    return FileManager.default.fileExists(atPath: fallback.path) ? fallback : nil
}()
let engine = AVAudioEngine()
let reverb = AVAudioUnitReverb()
let submix = AVAudioMixerNode()
let samplers = programs.map { _ in AVAudioUnitSampler() }
engine.attach(reverb)
engine.attach(submix)
// The reverb has a single input bus: connecting every sampler straight to it
// silently replaced the previous link (only the last voice sounded).
// A mixer takes one bus per sampler.
for sampler in samplers {
    engine.attach(sampler)
    engine.connect(sampler, to: submix, format: nil)
}
// Where each section sits on stage, as on the site (instruments.js PAN): strings and harp left,
// cello and vibraphone right, the tune in the middle.
let pans: [Float] = [-0.1, -0.7, 0, 0.7, 0, 0.6, 0.1, -0.6, 0, 0, 0, 0.15]
for (sampler, pan) in zip(samplers, pans) { sampler.pan = pan }
// The site's master chain: +9 dB makeup (the arrangement is lighter than a pile of voices), +2 dB
// for the stage seating (panned voices lose ~2 dB in the mixer: measured 24.2 vs 26.2 dB RMS), then
// a peak limiter so a full orchestra at its climax never clips.
let makeup = AVAudioUnitEQ(numberOfBands: 0)
makeup.globalGain = 11
let limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
    componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
    componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
engine.attach(makeup)
engine.attach(limiter)
// SONATA_ECO=1 (pil tasarrufu): the reverb is left out of the chain, about a third less CPU while
// playing (a bypassed reverb still costs the same).
if ProcessInfo.processInfo.environment["SONATA_ECO"] == "1" {
    engine.connect(submix, to: makeup, format: nil)
} else {
    engine.connect(submix, to: reverb, format: nil)
    engine.connect(reverb, to: makeup, format: nil)
}
engine.connect(makeup, to: limiter, format: nil)
engine.connect(limiter, to: engine.mainMixerNode, format: nil)
reverb.loadFactoryPreset(.mediumHall)
reverb.wetDryMix = 18
// SONATA_MUTE=1: everything runs, nothing is heard (timing measurements).
engine.mainMixerNode.outputVolume = ProcessInfo.processInfo.environment["SONATA_MUTE"] == "1" ? 0 : 0.9
let queue = DispatchQueue(label: "sonata.midi", qos: .userInteractive)
var generations = [Int: Int]()
var timers = [Int: DispatchSourceTimer]()
var sequence = 0
var lateCount = 0, lateSum = 0.0, lateMax = 0.0
var quietUntil = DispatchTime.now()     // the last note (with its reverb tail) is over by then
var pauses = 0, resumeMax = 0.0

// macOS stops the engine when the output device or its format changes
// (AirPods, display audio, sleep). Restart instead of playing into silence. The same call wakes the
// engine after an idle pause.
func ensureRunning() {
    if !engine.isRunning {
        let begin = DispatchTime.now()
        engine.prepare()
        try? engine.start()
        resumeMax = max(resumeMax, Double(DispatchTime.now().uptimeNanoseconds - begin.uptimeNanoseconds) / 1_000_000)
    }
}
// A running engine renders even silence (about 2% of a core). After a few quiet seconds it pauses,
// and the next note, which arrives ahead of its time, wakes it up again.
let idle = DispatchSource.makeTimerSource(queue: queue)
idle.schedule(deadline: .now() + 1, repeating: 1)
idle.setEventHandler {
    if engine.isRunning && generations.isEmpty && timers.isEmpty && DispatchTime.now() > quietUntil + 4 {
        engine.pause()
        pauses += 1
    }
}
idle.resume()
NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
    queue.async { ensureRunning() }
}

func silenceAll() {
    for (_, timer) in timers { timer.cancel() }
    timers.removeAll()
    for (key, _) in generations {
        samplers[key / 128].stopNote(UInt8(key % 128), onChannel: 0)
    }
    generations.removeAll()
    for sampler in samplers { sampler.sendController(120, withValue: 0, onChannel: 0) }
}

// Runs on `queue`.
func start(_ note: UInt8, _ velocity: UInt8, _ duration: Double, _ voice: Int) {
    let sampler = samplers[voice]
    let key = voice * 128 + Int(note)
    ensureRunning()
    sequence += 1
    let generation = sequence
    generations[key] = generation
    sampler.stopNote(note, onChannel: 0)
    sampler.startNote(note, withVelocity: velocity, onChannel: 0)
    quietUntil = max(quietUntil, .now() + duration)
    queue.asyncAfter(deadline: .now() + duration) {
        if generations[key] == generation {
            sampler.stopNote(note, onChannel: 0)
            generations.removeValue(forKey: key)
        }
    }
}

func load(_ sampler: AVAudioUnitSampler, _ program: UInt8, _ drums: Bool, from bank: URL) throws {
    let msb = drums ? kAUSampler_DefaultPercussionBankMSB : kAUSampler_DefaultMelodicBankMSB
    try sampler.loadSoundBankInstrument(at: bank, program: program, bankMSB: UInt8(msb), bankLSB: 0)
}

do {
    for (voice, (sampler, program)) in zip(samplers, programs).enumerated() {
        let drums = percussion.contains(voice)
        if let bank = custom, (try? load(sampler, program, drums, from: bank)) != nil { continue }
        try load(sampler, program, drums, from: system)
    }
    if let bank = custom { fputs("Piano: ses bankası \(bank.path)\n", stderr) }
    try engine.start()
    print("READY")
    fflush(stdout)
    while let line = readLine() {
        let parts = line.split(separator: " ")
        if parts.first == "quiet" {
            queue.sync { silenceAll() }
        } else if parts.first == "program", parts.count == 3, let voice = Int(parts[1]), let program = UInt8(parts[2]),
                  voice >= 0, voice < samplers.count, program < 128 {
            queue.sync {
                let drums = percussion.contains(voice)
                samplers[voice].sendController(120, withValue: 0, onChannel: 0)
                if let bank = custom, (try? load(samplers[voice], program, drums, from: bank)) != nil { return }
                if (try? load(samplers[voice], program, drums, from: system)) == nil {
                    try? load(samplers[voice], drums ? 0 : programs[voice], drums, from: system)   // unknown: back to the default
                }
            }
        } else if parts.first == "volume", parts.count == 2, let level = Double(parts[1]), level >= 0, level <= 100 {
            if ProcessInfo.processInfo.environment["SONATA_MUTE"] != "1" {
                queue.sync { engine.mainMixerNode.outputVolume = Float(0.9 * level / 100) }
            }
        } else if parts.first == "stats" {
            queue.sync {
                print(String(format: "STATS %d %.2f %.2f pauses %d resume_max_ms %.1f running %d", lateCount, lateCount > 0 ? lateSum / Double(lateCount) : 0, lateMax, pauses, resumeMax, engine.isRunning ? 1 : 0))
                fflush(stdout)
            }
        } else if (3...5).contains(parts.count),
                  let note = UInt8(parts[0]), note < 128,
                  let velocity = UInt8(parts[1]), velocity < 128,
                  let duration = Double(parts[2]), duration > 0, duration <= 10 {
            let voice = parts.count >= 4 ? (Int(parts[3]) ?? 0) : 0
            guard voice >= 0 && voice < samplers.count else { continue }
            let delay = parts.count == 5 ? min(10_000, max(0, Double(parts[4]) ?? 0)) : 0   // a closing chord can sit ~3 s ahead
            if delay < 0.5 {
                queue.sync { start(note, velocity, duration, voice) }
                continue
            }
            let target = DispatchTime.now() + .microseconds(Int(delay * 1000))
            queue.sync {
                ensureRunning()   // wake up now, so the engine is warm when the note's time comes
                sequence += 1
                let id = sequence
                let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
                timer.schedule(deadline: target, leeway: .nanoseconds(0))
                timer.setEventHandler {
                    let late = Double(DispatchTime.now().uptimeNanoseconds &- target.uptimeNanoseconds) / 1_000_000
                    if late < 1000 { lateCount += 1; lateSum += late; lateMax = max(lateMax, late) }
                    timers.removeValue(forKey: id)?.cancel()
                    start(note, velocity, duration, voice)
                }
                timers[id] = timer
                timer.resume()
            }
        }
    }
    queue.sync { silenceAll() }
    engine.stop()
} catch {
    fputs("Piano: \(error.localizedDescription)\n", stderr)
    exit(1)
}
