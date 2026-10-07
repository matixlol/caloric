import AVFoundation
import Foundation
import Observation

@MainActor @Observable
final class VoiceRecorder {
    private(set) var recording = false
    private(set) var starting = false
    private(set) var seconds = 0
    private(set) var levels = Array(repeating: 0.08, count: 18)
    var error: String?
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var startID: UUID?
    @ObservationIgnored private var interruptionObserver: NSObjectProtocol?
    #if DEBUG
    @ObservationIgnored private var simulatedStart: Date?
    #endif
    var duration: String { String(format: "%d:%02d", seconds / 60, seconds % 60) }

    init() {
        interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            guard let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  type == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor [weak self] in
                guard let self, recording || starting else { return }
                _ = stop(cancelled: true)
                error = "Recording was interrupted and discarded. Hold the microphone to try again."
            }
        }
    }

    deinit {
        timer?.cancel()
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
    }

    func start() async {
        guard !recording, startID == nil else { return }
        #if DEBUG
        if AppConfiguration.uiTesting, ProcessInfo.processInfo.arguments.contains("-ui-test-voice") {
            // UI gesture tests do not depend on an available host audio-input device.
            simulatedStart = Date(); recording = true; seconds = 0; error = nil
            timer = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(65)) } catch { return }
                    guard let self, let simulatedStart else { return }
                    let elapsed = Date().timeIntervalSince(simulatedStart)
                    seconds = Int(elapsed)
                    levels.removeFirst(); levels.append(0.1 + abs(sin(elapsed * 5)) * 0.85)
                }
            }
            return
        }
        #endif
        let id = UUID(); startID = id; starting = true; error = nil
        defer { if startID == id { startID = nil; starting = false } }
        let granted = await AVAudioApplication.requestRecordPermission()
        guard startID == id else { return }
        guard granted else { error = "Allow microphone access in Settings to log food with voice."; return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("caloric-\(UUID().uuidString).m4a")
            recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue])
            recorder?.isMeteringEnabled = true
            guard recorder?.record() == true else { throw URLError(.cannotCreateFile) }
            recording = true; starting = false; seconds = 0; levels = Array(repeating: 0.08, count: 18); error = nil
            timer = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(65)) } catch { return }
                    guard let self else { return }
                    seconds = Int(recorder?.currentTime ?? 0)
                    recorder?.updateMeters()
                    let power = recorder?.averagePower(forChannel: 0) ?? -60
                    let level = max(0.08, min(1, pow(10, Double(power) / 35)))
                    levels.removeFirst(); levels.append(level)
                }
            }
        } catch {
            _ = stop(cancelled: true)
            self.error = "Could not start recording. \(error.localizedDescription)"
        }
    }
    func stop(cancelled: Bool = false) -> URL? {
        startID = nil; starting = false; timer?.cancel(); timer = nil
        let url = recorder?.url
        let elapsed = recorder?.currentTime ?? 0
        recorder?.stop(); recorder = nil; recording = false
        #if DEBUG
        simulatedStart = nil
        #endif
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if cancelled || elapsed < 0.4, let url {
            try? FileManager.default.removeItem(at: url)
            if !cancelled { error = "Hold the microphone while speaking, then release to send." }
            return nil
        }
        return url
    }
}
