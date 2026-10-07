import Foundation

struct BackupSnapshot: Encodable, Sendable {
    var userID: String
    var settings: UserSettings
    var entries: [FoodRecord]
    var recipes: [RecipeRecord] = []
}

actor CloudBackup {
    static let shared = CloudBackup()
    private var writing = false
    static func ensure(_ snapshot: BackupSnapshot) async { await shared.write(snapshot) }
    private func write(_ snapshot: BackupSnapshot) {
        guard !writing else { return }
        writing = true
        defer { writing = false }
        guard let container = FileManager.default.url(forUbiquityContainerIdentifier: "iCloud.lol.mati.caloric.swift") else { return }
        do {
            let folder = container.appendingPathComponent("Documents/Backups/\(snapshot.userID)")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let urls = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])
            let latest = urls.compactMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }.max()
            if let latest, Date().timeIntervalSince(latest) < 86400 { return }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(snapshot).write(to: folder.appendingPathComponent("caloric-\(LocalDay.key()).json"), options: .atomic)
        } catch { /* Backup is optional when iCloud is unavailable. */ }
    }
}
