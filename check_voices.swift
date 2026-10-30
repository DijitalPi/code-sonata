import Foundation
import AVFoundation
// Offline render: every voice must be > 0 (a 0.000 means it is not connected).
let programs: [UInt8] = [0, 48, 52, 42, 73, 11, 60, 46, 47, 44, 0, 21]   // same list as Piano.swift
let bank = URL(fileURLWithPath: "/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls")
func measure(fixed: Bool, voice: Int) -> Float {
  let engine = AVAudioEngine()
  let reverb = AVAudioUnitReverb()
  let submix = AVAudioMixerNode()
  let samplers = programs.map { _ in AVAudioUnitSampler() }
  engine.attach(reverb); engine.attach(submix)
  let fmt = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
  try! engine.enableManualRenderingMode(.offline, format: fmt, maximumFrameCount: 4096)
  for s in samplers { engine.attach(s); engine.connect(s, to: fixed ? submix : reverb, format: nil) }
  if fixed { engine.connect(submix, to: reverb, format: nil) }
  engine.connect(reverb, to: engine.mainMixerNode, format: nil)
  for (i, (s, p)) in zip(samplers, programs).enumerated() { try! s.loadSoundBankInstrument(at: bank, program: p, bankMSB: UInt8(i == 10 ? kAUSampler_DefaultPercussionBankMSB : kAUSampler_DefaultMelodicBankMSB), bankLSB: 0) }
  try! engine.start()
  samplers[voice].startNote(voice == 10 ? 38 : 64, withVelocity: 100, onChannel: 0)  // snare on the kit
  let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 4096)!
  var sum: Float = 0; var n = 0
  for _ in 0..<10 { _ = try! engine.renderOffline(4096, to: buf)
    let d = buf.floatChannelData![0]; for i in 0..<Int(buf.frameLength) { sum += d[i]*d[i] }; n += Int(buf.frameLength) }
  engine.stop()
  return sqrt(sum / Float(n))
}
for fixed in [true] {
  print(fixed ? "YENİ:" : "ESKİ:", (0..<programs.count).map { String(format: "%.3f", measure(fixed: fixed, voice: $0)) }.joined(separator: " "))
}
