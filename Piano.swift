import Foundation
import AVFoundation

// One sampler per voice (General MIDI program). Commands on stdin:
//   "<note> <velocity> <seconds> [voice]"   voice defaults to 0 (piano)
//   "quiet"
// All MIDI operations are serialized. Generations protect repeated notes
// from an earlier note's delayed release.
// piano, strings, choir, cello, flute, vibraphone, horn, harp, timpani, tremolo strings, drum kit
let programs: [UInt8] = [0, 48, 52, 42, 73, 11, 60, 46, 47, 44, 0]
let percussion: Set<Int> = [10]
let bank = URL(fileURLWithPath: "/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls")
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
engine.connect(submix, to: reverb, format: nil)
engine.connect(reverb, to: engine.mainMixerNode, format: nil)
reverb.loadFactoryPreset(.mediumHall)
reverb.wetDryMix = 18
engine.mainMixerNode.outputVolume = 0.9
let queue = DispatchQueue(label: "sonata.midi")
var generations = [Int: Int]()
var sequence = 0

// macOS stops the engine when the output device or its format changes
// (AirPods, display audio, sleep). Restart instead of playing into silence.
func ensureRunning() {
    if !engine.isRunning {
        engine.prepare()
        try? engine.start()
    }
}
NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
    queue.async { ensureRunning() }
}

func silenceAll() {
    for (key, _) in generations {
        samplers[key / 128].stopNote(UInt8(key % 128), onChannel: 0)
    }
    generations.removeAll()
    for sampler in samplers { sampler.sendController(120, withValue: 0, onChannel: 0) }
}

do {
    for (voice, (sampler, program)) in zip(samplers, programs).enumerated() {
        let msb = percussion.contains(voice) ? kAUSampler_DefaultPercussionBankMSB : kAUSampler_DefaultMelodicBankMSB
        try sampler.loadSoundBankInstrument(at: bank, program: program, bankMSB: UInt8(msb), bankLSB: 0)
    }
    try engine.start()
    print("READY")
    fflush(stdout)
    while let line = readLine() {
        let parts = line.split(separator: " ")
        if parts.first == "quiet" {
            queue.sync { silenceAll() }
        } else if parts.count == 3 || parts.count == 4,
                  let note = UInt8(parts[0]), note < 128,
                  let velocity = UInt8(parts[1]), velocity < 128,
                  let duration = Double(parts[2]), duration > 0, duration <= 10 {
            let voice = parts.count == 4 ? (Int(parts[3]) ?? 0) : 0
            guard voice >= 0 && voice < samplers.count else { continue }
            let sampler = samplers[voice]
            let key = voice * 128 + Int(note)
            queue.sync {
                ensureRunning()
                sequence += 1
                let generation = sequence
                generations[key] = generation
                sampler.stopNote(note, onChannel: 0)
                sampler.startNote(note, withVelocity: velocity, onChannel: 0)
                queue.asyncAfter(deadline: .now() + duration) {
                    if generations[key] == generation {
                        sampler.stopNote(note, onChannel: 0)
                        generations.removeValue(forKey: key)
                    }
                }
            }
        }
    }
    queue.sync { silenceAll() }
    engine.stop()
} catch {
    fputs("Piano: \(error.localizedDescription)\n", stderr)
    exit(1)
}
