import Foundation
import os
import QuartzCore

/// Launch / interaction timing in the unified log (`subsystem: lol.mati.caloric.swift`, category `performance`)
/// and as Points of Interest signposts in Instruments.
enum PerformanceLog {
    static let logger = Logger(subsystem: "lol.mati.caloric.swift", category: "performance")
    static let signposter = OSSignposter(subsystem: "lol.mati.caloric.swift", category: .pointsOfInterest)

    /// Milliseconds since the kernel started this process (includes pre-main work).
    static var sinceProcessStart: Double {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0 else { return -1 }
        let start = info.kp_proc.p_un.__p_starttime
        let started = Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
        return (Date().timeIntervalSince1970 - started) * 1000
    }

    static func mark(_ name: StaticString) {
        signposter.emitEvent(name)
        logger.log("\(name, privacy: .public) at +\(Int(sinceProcessStart), privacy: .public) ms")
    }

    private static var marked = Set<String>()
    /// Logs the first occurrence only (e.g. the first diary frame).
    @MainActor static func markOnce(_ name: StaticString) {
        guard marked.insert("\(name)").inserted else { return }
        mark(name)
    }
}

/// With `-perf-hitches`, logs main-thread frame gaps longer than 1.5 frames.
@MainActor
final class MainThreadHitchMonitor: NSObject {
    static let shared = MainThreadHitchMonitor()
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0

    func startIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("-perf-hitches"), link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        defer { last = link.timestamp }
        guard last > 0 else { return }
        let frame = link.targetTimestamp - link.timestamp
        let gap = link.timestamp - last
        if frame > 0, gap > frame * 1.5 {
            PerformanceLog.logger.log("hitch \(Int(gap * 1000), privacy: .public) ms (\(Int(gap / frame) - 1, privacy: .public) frames dropped) at +\(Int(PerformanceLog.sinceProcessStart), privacy: .public) ms")
        }
    }
}
