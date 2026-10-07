import Foundation
import SQLite3

/// Payloads use the same JSON schema as data-model; the database lives in this app's sandbox.
final class SQLiteStore {
    private var db: OpaquePointer?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open(url.path, &db) == SQLITE_OK else { throw failure() }
        try execute("PRAGMA journal_mode=WAL")
        try execute("CREATE TABLE IF NOT EXISTS food_entries (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, dirty INTEGER NOT NULL DEFAULT 0)")
        try execute("CREATE TABLE IF NOT EXISTS user_settings (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0)")
        try execute("CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, dirty INTEGER NOT NULL DEFAULT 0)")
    }
    deinit { sqlite3_close(db) }
    private func failure() -> NSError {
        NSError(domain: "CaloricSQLite", code: Int(sqlite3_errcode(db)), userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
    }
    private func statement(_ sql: String) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw failure() }
        return stmt
    }
    private func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw failure() }
    }
    func transaction(_ action: () throws -> Void) throws {
        try execute("BEGIN IMMEDIATE")
        do { try action(); try execute("COMMIT") }
        catch { try? execute("ROLLBACK"); throw error }
    }
    private func text(_ stmt: OpaquePointer, _ column: Int32) -> String {
        String(cString: sqlite3_column_text(stmt, column))
    }
    func loadEntries() throws -> [FoodRecord] {
        let stmt = try statement("SELECT id,payload_json,updated_at,deleted_at,dirty FROM food_entries")
        defer { sqlite3_finalize(stmt) }
        var result: [FoodRecord] = []
        var status = sqlite3_step(stmt)
        while status == SQLITE_ROW {
            let data = try decoder.decode(FoodEntry.self, from: Data(text(stmt, 1).utf8))
            result.append(FoodRecord(id: text(stmt, 0), data: data, updatedAt: sqlite3_column_int64(stmt, 2),
                                     deletedAt: sqlite3_column_type(stmt, 3) == SQLITE_NULL ? nil : sqlite3_column_int64(stmt, 3),
                                     dirty: sqlite3_column_int(stmt, 4) != 0))
            status = sqlite3_step(stmt)
        }
        guard status == SQLITE_DONE else { throw failure() }
        return result
    }
    func loadSettings() throws -> SettingsRecord? {
        let stmt = try statement("SELECT payload_json,updated_at,dirty FROM user_settings WHERE id='settings'")
        defer { sqlite3_finalize(stmt) }
        let status = sqlite3_step(stmt)
        if status == SQLITE_DONE { return nil }
        guard status == SQLITE_ROW else { throw failure() }
        return SettingsRecord(data: try decoder.decode(UserSettings.self, from: Data(text(stmt, 0).utf8)),
                              updatedAt: sqlite3_column_int64(stmt, 1), dirty: sqlite3_column_int(stmt, 2) != 0)
    }
    func loadRecipes() throws -> [RecipeRecord] {
        let stmt = try statement("SELECT id,payload_json,updated_at,deleted_at,dirty FROM recipes")
        defer { sqlite3_finalize(stmt) }
        var rows: [RecipeRecord] = []
        var status = sqlite3_step(stmt)
        while status == SQLITE_ROW {
            rows.append(RecipeRecord(id: text(stmt, 0), data: try decoder.decode(Recipe.self, from: Data(text(stmt, 1).utf8)),
                updatedAt: sqlite3_column_int64(stmt, 2), deletedAt: sqlite3_column_type(stmt, 3) == SQLITE_NULL ? nil : sqlite3_column_int64(stmt, 3), dirty: sqlite3_column_int(stmt, 4) != 0))
            status = sqlite3_step(stmt)
        }
        guard status == SQLITE_DONE else { throw failure() }
        return rows
    }
    func save(_ row: RecipeRecord) throws {
        let stmt = try statement("INSERT INTO recipes (id,payload_json,updated_at,deleted_at,dirty) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,dirty=excluded.dirty")
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, row.id, -1, transient)
        sqlite3_bind_text(stmt, 2, String(decoding: try encoder.encode(row.data), as: UTF8.self), -1, transient)
        sqlite3_bind_int64(stmt, 3, row.updatedAt)
        if let deleted = row.deletedAt { sqlite3_bind_int64(stmt, 4, deleted) } else { sqlite3_bind_null(stmt, 4) }
        sqlite3_bind_int(stmt, 5, row.dirty ? 1 : 0)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw failure() }
    }
    func save(_ row: FoodRecord) throws {
        let stmt = try statement("INSERT INTO food_entries (id,payload_json,updated_at,deleted_at,dirty) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,dirty=excluded.dirty")
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, row.id, -1, transient)
        let json = String(decoding: try encoder.encode(row.data), as: UTF8.self)
        sqlite3_bind_text(stmt, 2, json, -1, transient)
        sqlite3_bind_int64(stmt, 3, row.updatedAt)
        if let deleted = row.deletedAt { sqlite3_bind_int64(stmt, 4, deleted) } else { sqlite3_bind_null(stmt, 4) }
        sqlite3_bind_int(stmt, 5, row.dirty ? 1 : 0)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw failure() }
    }
    func save(_ row: SettingsRecord) throws {
        let stmt = try statement("INSERT INTO user_settings (id,payload_json,updated_at,dirty) VALUES ('settings',?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at,dirty=excluded.dirty")
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, String(decoding: try encoder.encode(row.data), as: UTF8.self), -1, transient)
        sqlite3_bind_int64(stmt, 2, row.updatedAt)
        sqlite3_bind_int(stmt, 3, row.dirty ? 1 : 0)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw failure() }
    }
}
