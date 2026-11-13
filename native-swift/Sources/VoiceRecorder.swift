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
    @ObservationIgnored private let audioQueue = DispatchQueue(label: "caloric.voice-audio")
    #if DEBUG
    @ObservationIgnored private var simulatedStart: Date?
    #endif
    var duration: String { String(format: "%d:%02d", seconds / 60, seconds % 60) }

    init() {
        // Load the audio session category and AAC encoder ahead of the first hold, off the main thread.
        // SwiftUI may build throwaway @State initial values; the static runs once per process.
        audioQueue.asyncAfter(deadline: .now() + 1) { _ = Self.prewarmed }
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
        resetMeter()
        let id = UUID(); startID = id; starting = true; error = nil
        defer { if startID == id { startID = nil; starting = false } }
        #if DEBUG
        if AppConfiguration.uiTesting, ProcessInfo.processInfo.arguments.contains("-ui-test-voice") {
            // UI gesture tests do not depend on an available host audio-input device.
            if ProcessInfo.processInfo.arguments.contains("-ui-test-voice-slow-start") {
                try? await Task.sleep(for: .milliseconds(450))
                guard startID == id else { return }
            }
            simulatedStart = Date(); recording = true; seconds = 0; error = nil
            starting = false
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
        let granted: Bool
        switch AVAudioApplication.shared.recordPermission {
        case .granted: granted = true
        case .denied: granted = false
        case .undetermined: granted = await AVAudioApplication.requestRecordPermission()
        @unknown default: granted = false
        }
        guard startID == id else { return }
        guard granted else { error = "Allow microphone access in Settings to log food with voice."; return }
        do {
            // Audio-route activation and starting the audio queue can each take hundreds of
            // milliseconds (more with Bluetooth). Do both off the main thread so touch feedback,
            // animations and lock/cancel gestures stay responsive.
            let prepared: AVAudioRecorder = try await withCheckedThrowingContinuation { continuation in
                audioQueue.async {
                    do {
                        let recorder = try Self.prepareRecorder()
                        guard recorder.record() else {
                            try? FileManager.default.removeItem(at: recorder.url)
                            throw URLError(.cannotCreateFile)
                        }
                        continuation.resume(returning: recorder)
                    } catch { continuation.resume(throwing: error) }
                }
            }
            guard startID == id else {
                audioQueue.async {
                    prepared.stop(); try? FileManager.default.removeItem(at: prepared.url)
                    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                }
                return
            }
            recorder = prepared
            recording = true; starting = false; seconds = 0; levels = Array(repeating: 0.08, count: 18); error = nil
            PerformanceLog.mark("voice recording")
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
            guard startID == id else { return }
            _ = stop(cancelled: true)
            self.error = "Could not start recording. \(error.localizedDescription)"
        }
    }
    /// Called on touch down, before the recording card appears, so it never shows the previous note.
    func resetMeter() {
        guard !recording, startID == nil else { return }
        seconds = 0; levels = Array(repeating: 0.08, count: 18)
    }
    nonisolated private static let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue]
    /// Setting the category does not activate the session, so other apps' audio is untouched until recording.
    nonisolated private static func configureCategory() throws {
        let session = AVAudioSession.sharedInstance()
        guard session.category != .playAndRecord || session.mode != .default || session.categoryOptions != [.defaultToSpeaker, .allowBluetoothHFP] else { return }
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
    }
    nonisolated private static let prewarmed: Void = {
        try? configureCategory()
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("caloric-prewarm-\(UUID().uuidString).m4a")
        _ = try? AVAudioRecorder(url: url, settings: settings)
        try? FileManager.default.removeItem(at: url)
    }()
    nonisolated private static func prepareRecorder() throws -> AVAudioRecorder {
        try configureCategory()
        try AVAudioSession.sharedInstance().setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("caloric-\(UUID().uuidString).m4a")
        do {
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.prepareToRecord() else { throw URLError(.cannotCreateFile) }
            return recorder
        } catch { try? FileManager.default.removeItem(at: url); throw error }
    }
    /// Stops on the audio queue (finalizing the file can block); `completion` receives a finished
    /// recording on the main actor. Cancelled or too-short recordings are deleted.
    func stop(cancelled: Bool = false, completion: (@MainActor (URL) -> Void)? = nil) {
        startID = nil; starting = false; timer?.cancel(); timer = nil
        let active = recorder
        let elapsed = active?.currentTime ?? 0
        recorder = nil; recording = false
        #if DEBUG
        simulatedStart = nil
        #endif
        let keep = active != nil && !cancelled && elapsed >= 0.4
        if active != nil, !cancelled, !keep { error = "Hold the microphone while speaking, then release to send." }
        audioQueue.async {
            active?.stop()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            guard let url = active?.url else { return }
            guard keep, let completion else { try? FileManager.default.removeItem(at: url); return }
            Task { @MainActor in completion(url) }
        }
    }
}
