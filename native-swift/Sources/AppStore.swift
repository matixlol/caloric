import Foundation
import Observation

@MainActor @Observable
final class AppStore {
    private(set) var records: [FoodRecord] = []
    private(set) var recipeRecords: [RecipeRecord] = []
    private(set) var settingsRecord = SettingsRecord(data: UserSettings(), updatedAt: 0)
    private(set) var userID: String?
    private(set) var ready = false
    private(set) var isSyncing = false
    private(set) var lastSyncedAt: Date?
    private(set) var syncError: String?
    var error: String?
    @ObservationIgnored private var database: SQLiteStore?
    @ObservationIgnored private var syncTask: Task<Void, Never>?
    @ObservationIgnored private let api: any SyncAPI
    @ObservationIgnored private let directory: URL
    @ObservationIgnored private let syncEnabled: Bool
    @ObservationIgnored private var syncQueued = false
    @ObservationIgnored private var retryAttempt = 0
    @ObservationIgnored private let retryDelays: [Duration]

    init(api: (any SyncAPI)? = nil, directory: URL? = nil, syncEnabled: Bool = true,
         retryDelays: [Duration] = [.seconds(1), .seconds(3), .seconds(10)]) {
        self.api = api ?? APIClient()
        self.syncEnabled = syncEnabled
        self.retryDelays = retryDelays
        self.directory = directory ?? (AppConfiguration.uiTesting
            ? FileManager.default.temporaryDirectory.appendingPathComponent("CaloricUITests-\(ProcessInfo.processInfo.processIdentifier)")
            : FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CaloricSwift"))
    }
    var settings: UserSettings { settingsRecord.data }
    var entries: [FoodRecord] {
        records.filter { $0.deletedAt == nil }.sorted {
            $0.data.createdAt == $1.data.createdAt ? $0.id > $1.id : $0.data.createdAt > $1.data.createdAt
        }
    }
    var recipes: [RecipeRecord] { recipeRecords.filter { $0.deletedAt == nil }.sorted { $0.data.name.localizedCaseInsensitiveCompare($1.data.name) == .orderedAscending } }
    var dirty: Bool { settingsRecord.dirty || records.contains(where: \.dirty) || recipeRecords.contains(where: \.dirty) }
    func entries(on day: String, meal: Meal? = nil) -> [FoodRecord] {
        entries.filter { $0.data.dateKey == day && (meal == nil || $0.data.meal == meal) }.sorted {
            $0.data.sortIndex == $1.data.sortIndex ? $0.data.createdAt < $1.data.createdAt : $0.data.sortIndex < $1.data.sortIndex
        }
    }
    func activate(userID: String?) async {
        syncTask?.cancel()
        retryAttempt = 0
        self.userID = userID
        records = []; recipeRecords = []; settingsRecord = SettingsRecord(data: UserSettings(), updatedAt: 0)
        database = nil; ready = false; lastSyncedAt = nil; error = nil; syncError = nil
        WidgetSnapshot.clear()
        guard let userID else { return }
        do {
            let filename = userID.utf8.map { String(format: "%02x", $0) }.joined()
            database = try SQLiteStore(url: directory.appendingPathComponent("\(filename).sqlite"))
            records = try database!.loadEntries()
            recipeRecords = try database!.loadRecipes()
            settingsRecord = try database!.loadSettings() ?? settingsRecord
            ready = true
            updateWidget()
            if syncEnabled && !AppConfiguration.uiTesting { await synchronize() }
            await ensureBackup()
        } catch { self.error = "Could not load your local data. \(error.localizedDescription)" }
    }
    @discardableResult
    func add(food: SearchFood, meal: Meal, day: String = LocalDay.key(), portion: Double = 1) throws -> FoodRecord {
        let now = LocalDay.milliseconds()
        let data = FoodEntry(meal: meal, foodName: food.name, brand: food.brand, serving: food.serving,
                             portion: Portion.sanitize(portion), nutrition: food.nutrition, createdAt: now, dateKey: day,
                             sortIndex: (entries(on: day, meal: meal).map { $0.data.sortIndex }.max() ?? -1) + 1)
        let row = FoodRecord(id: "food_entry_\(UUID().uuidString.lowercased())", data: data, updatedAt: now, dirty: true)
        try persist(row)
        return row
    }
    func update(id: String, _ action: (inout FoodEntry) -> Void) throws {
        guard var row = records.first(where: { $0.id == id && $0.deletedAt == nil }) else { return }
        let previous = row.data
        action(&row.data)
        guard row.data != previous else { return }
        row.updatedAt = max(LocalDay.milliseconds(), row.updatedAt + 1); row.dirty = true
        try persist(row)
    }
    @discardableResult
    func createRecipe(name: String = "New recipe", items: [RecipeItem] = []) throws -> RecipeRecord {
        let now = LocalDay.milliseconds()
        let row = RecipeRecord(id: "recipe_\(UUID().uuidString.lowercased())", data: Recipe(name: name, items: items, createdAt: now), updatedAt: now, dirty: true)
        try persistRecipe(row)
        return row
    }
    func updateRecipe(id: String, _ action: (inout Recipe) -> Void) throws {
        guard var row = recipes.first(where: { $0.id == id }) else { return }
        let previous = row.data
        action(&row.data)
        row.data.name = row.data.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !row.data.name.isEmpty else { throw APIError.response(400, "Enter a recipe name.") }
        guard row.data != previous else { return }
        row.updatedAt = max(LocalDay.milliseconds(), row.updatedAt + 1); row.dirty = true
        try persistRecipe(row)
    }
    @discardableResult
    func duplicateRecipe(id: String) throws -> RecipeRecord? {
        guard let recipe = recipes.first(where: { $0.id == id }) else { return nil }
        return try createRecipe(name: recipe.data.name + " copy", items: recipe.data.items.map {
            var item = $0; item.id = UUID().uuidString.lowercased(); return item
        })
    }
    func deleteRecipe(id: String) throws {
        guard var row = recipes.first(where: { $0.id == id }) else { return }
        row.updatedAt = max(LocalDay.milliseconds(), row.updatedAt + 1); row.deletedAt = row.updatedAt; row.dirty = true
        try persistRecipe(row)
    }
    @discardableResult
    func logRecipe(_ recipe: RecipeRecord, meal: Meal, day: String, portion: Double = 1) throws -> FoodRecord {
        let now = LocalDay.milliseconds()
        let row = FoodRecord(id: "food_entry_\(UUID().uuidString.lowercased())", data: FoodEntry(meal: meal, foodName: recipe.data.name, serving: "1 recipe", portion: Portion.sanitize(portion), nutrition: recipe.data.nutrition, createdAt: now, dateKey: day,
            sortIndex: (entries(on: day, meal: meal).map { $0.data.sortIndex }.max() ?? -1) + 1, recipeId: recipe.id, recipeItems: recipe.data.items), updatedAt: now, dirty: true)
        try persist(row)
        return row
    }
    func updateLoggedRecipe(id: String, items: [RecipeItem]) throws {
        try update(id: id) { $0.recipeItems = items; $0.nutrition = Nutrition.aggregate(items) }
    }
    private func persistRecipe(_ row: RecipeRecord) throws {
        guard let database else { throw APIError.signedOut }
        try database.save(row)
        if let i = recipeRecords.firstIndex(where: { $0.id == row.id }) { recipeRecords[i] = row }
        else { recipeRecords.append(row) }
        scheduleSync()
    }
    func delete(id: String) throws {
        guard var row = records.first(where: { $0.id == id }) else { return }
        row.updatedAt = max(LocalDay.milliseconds(), row.updatedAt + 1)
        row.deletedAt = row.updatedAt; row.dirty = true
        try persist(row)
    }
    func move(id: String, to meal: Meal, day: String, before targetID: String? = nil) throws {
        guard let source = records.first(where: { $0.id == id && $0.deletedAt == nil }), source.data.dateKey == day else { return }
        var ordered = entries(on: day, meal: meal).filter { $0.id != id }
        let index = targetID.flatMap { target in ordered.firstIndex { $0.id == target } } ?? ordered.count
        ordered.insert(source, at: index)
        let now = LocalDay.milliseconds()
        let rows: [FoodRecord] = ordered.enumerated().compactMap { offset, row in
            guard row.data.meal != meal || row.data.sortIndex != Double(offset) else { return nil }
            var row = row
            row.data.meal = meal; row.data.sortIndex = Double(offset)
            row.updatedAt = max(now, row.updatedAt + 1); row.dirty = true
            return row
        }
        guard !rows.isEmpty else { return }
        guard let database else { throw APIError.signedOut }
        try database.transaction { for row in rows { try database.save(row) } }
        for row in rows { replace(row) }
        updateWidget()
        scheduleSync()
    }
    func saveSettings(_ data: UserSettings) throws {
        guard data.isValid else { throw APIError.response(400, "Calories must be 100–10,000 and macro percentages must add up to 100.") }
        guard data != settings else { return }
        let row = SettingsRecord(data: data, updatedAt: max(LocalDay.milliseconds(), settingsRecord.updatedAt + 1), dirty: true)
        guard let database else { throw APIError.signedOut }
        try database.save(row)
        settingsRecord = row; updateWidget(); scheduleSync()
    }
    private func persist(_ row: FoodRecord) throws {
        guard let database else { throw APIError.signedOut }
        try database.save(row); replace(row); updateWidget(); scheduleSync()
    }
    private func replace(_ row: FoodRecord) {
        if let index = records.firstIndex(where: { $0.id == row.id }) { records[index] = row }
        else { records.append(row) }
    }
    func perform(_ action: () throws -> Void) {
        do { try action(); error = nil } catch { self.error = error.localizedDescription }
    }
    private func scheduleSync(after delay: Duration = .milliseconds(700)) {
        guard syncEnabled, !AppConfiguration.uiTesting else { return }
        syncTask?.cancel()
        syncTask = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            await self?.synchronize()
        }
    }
    private func retrySync(after error: Error) {
        let retryable: Bool
        switch error {
        case APIError.signedOut: retryable = true
        case let APIError.response(code, _): retryable = code == 401 || code == 429 || (500...599).contains(code)
        case let error as URLError: retryable = [.timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(error.code)
        default: retryable = false
        }
        guard retryable, retryAttempt < retryDelays.count else { return }
        let delay = retryDelays[retryAttempt]; retryAttempt += 1
        scheduleSync(after: delay)
    }
    /// A newer local edit survives a bootstrap response and an older push acknowledgement.
    func merge(_ payload: BootstrapResponse, rejected: PushRequest? = nil) throws {
        guard let database else { return }
        let incomingIDs = Set(payload.foodEntries.map(\.id))
        var next = records.filter { $0.dirty || $0.deletedAt != nil || incomingIDs.contains($0.id) }
        var nextSettings = settingsRecord
        for row in payload.foodEntries {
            if let i = next.firstIndex(where: { $0.id == row.id }) {
                let rejectedVersion = rejected?.foodEntries.first { $0.id == row.id }?.updatedAt
                let conflict = rejectedVersion == next[i].updatedAt && row.updatedAt > next[i].updatedAt
                if (!next[i].dirty && row.updatedAt >= next[i].updatedAt) || conflict { next[i] = row }
            } else { next.append(row) }
        }
        for index in next.indices where !incomingIDs.contains(next[index].id) {
            if rejected?.foodEntries.contains(where: { $0.id == next[index].id && $0.updatedAt == next[index].updatedAt }) == true {
                // A rejected older write whose ID is absent from the active snapshot
                // lost to a newer server deletion. Do not retry and resurrect it.
                next[index].deletedAt = max(next[index].deletedAt ?? 0, next[index].updatedAt)
                next[index].dirty = false
            }
        }
        if let row = payload.settings {
            let conflict = rejected?.settings?.updatedAt == nextSettings.updatedAt && row.updatedAt > nextSettings.updatedAt
            if (!nextSettings.dirty && row.updatedAt >= nextSettings.updatedAt) || conflict { nextSettings = row }
        }
        // Bootstrap is a complete snapshot of active entries, so absent clean rows
        // were removed on another device. Keep pending writes and local tombstones.
        let removed = records.filter { row in !next.contains { $0.id == row.id } }
        let recipeIDs = Set(payload.recipes.map(\.id))
        var nextRecipes = recipeRecords.filter { $0.dirty || $0.deletedAt != nil || recipeIDs.contains($0.id) }
        for row in payload.recipes {
            if let i = nextRecipes.firstIndex(where: { $0.id == row.id }) {
                let rejectedVersion = rejected?.recipes.first { $0.id == row.id }?.updatedAt
                let conflict = rejectedVersion == nextRecipes[i].updatedAt && row.updatedAt > nextRecipes[i].updatedAt
                if (!nextRecipes[i].dirty && row.updatedAt >= nextRecipes[i].updatedAt) || conflict { nextRecipes[i] = row }
            } else { nextRecipes.append(row) }
        }
        for i in nextRecipes.indices where !recipeIDs.contains(nextRecipes[i].id) {
            if rejected?.recipes.contains(where: { $0.id == nextRecipes[i].id && $0.updatedAt == nextRecipes[i].updatedAt }) == true {
                nextRecipes[i].deletedAt = max(nextRecipes[i].deletedAt ?? 0, nextRecipes[i].updatedAt)
                nextRecipes[i].dirty = false
            }
        }
        let removedRecipes = recipeRecords.filter { row in !nextRecipes.contains { $0.id == row.id } }
        try database.transaction {
            for row in removed {
                var tombstone = row; tombstone.deletedAt = max(LocalDay.milliseconds(), row.updatedAt)
                try database.save(tombstone)
            }
            for row in next { try database.save(row) }
            for row in removedRecipes {
                var tombstone = row; tombstone.deletedAt = max(LocalDay.milliseconds(), row.updatedAt)
                try database.save(tombstone)
            }
            for row in nextRecipes { try database.save(row) }
            try database.save(nextSettings)
        }
        records = next; recipeRecords = nextRecipes; settingsRecord = nextSettings; updateWidget()
    }
    func acknowledge(_ sent: PushRequest, response: PushResponse) throws {
        guard let database else { return }
        var next = records
        var nextRecipes = recipeRecords
        var nextSettings = settingsRecord
        for row in sent.foodEntries where response.acceptedFoodEntryIds.contains(row.id) {
            if let i = next.firstIndex(where: { $0.id == row.id && $0.updatedAt == row.updatedAt }) { next[i].dirty = false }
        }
        if response.acceptedSettings, let row = sent.settings, nextSettings.updatedAt == row.updatedAt { nextSettings.dirty = false }
        for row in sent.recipes where response.acceptedRecipeIds.contains(row.id) {
            if let i = nextRecipes.firstIndex(where: { $0.id == row.id && $0.updatedAt == row.updatedAt }) { nextRecipes[i].dirty = false }
        }
        try database.transaction {
            for row in next { try database.save(row) }
            for row in nextRecipes { try database.save(row) }
            try database.save(nextSettings)
        }
        records = next; recipeRecords = nextRecipes; settingsRecord = nextSettings; updateWidget()
    }
    func synchronize() async {
        guard syncEnabled, let activeID = userID, ready, !AppConfiguration.uiTesting else { return }
        if isSyncing { syncQueued = true; return }
        isSyncing = true
        defer {
            isSyncing = false
            if syncQueued { syncQueued = false; scheduleSync() }
        }
        do {
            var uploadError: Error?
            var rejected: PushRequest?
            let sent = PushRequest(foodEntries: records.filter(\.dirty), settings: settingsRecord.dirty ? settingsRecord : nil, recipes: recipeRecords.filter(\.dirty))
            if !sent.foodEntries.isEmpty || sent.settings != nil || !sent.recipes.isEmpty {
                do {
                    let response = try await api.push(sent, userID: activeID)
                    guard userID == activeID, !Task.isCancelled else { return }
                    try acknowledge(sent, response: response)
                    rejected = PushRequest(foodEntries: sent.foodEntries.filter { !response.acceptedFoodEntryIds.contains($0.id) }, settings: response.acceptedSettings ? nil : sent.settings, recipes: sent.recipes.filter { !response.acceptedRecipeIds.contains($0.id) })
                } catch {
                    guard userID == activeID, !Task.isCancelled else { return }
                    uploadError = error
                }
            }
            let payload = try await api.bootstrap(userID: activeID)
            guard userID == activeID, !Task.isCancelled else { return }
            try merge(payload, rejected: rejected)
            if let uploadError {
                syncError = "Your saved data loaded, but local changes could not upload. \(uploadError.localizedDescription)"
                retrySync(after: uploadError)
            }
            else if dirty { syncError = "Some local changes were not accepted by the server." }
            else { syncError = nil; lastSyncedAt = Date(); retryAttempt = 0 }
            await ensureBackup()
        } catch {
            // Offline edits remain durable and pending; foreground/reachability retries them.
            if userID == activeID, !Task.isCancelled { syncError = "Could not sync. \(error.localizedDescription)"; retrySync(after: error) }
        }
    }
    func ensureBackup() async {
        guard let userID, ready, !AppConfiguration.uiTesting else { return }
        let snapshot = BackupSnapshot(userID: userID, settings: settings, entries: entries, recipes: recipes)
        await CloudBackup.ensure(snapshot)
    }
    func updateWidget() {
        guard ready, userID != nil, !AppConfiguration.uiTesting else { return }
        WidgetSnapshot.write(nutrition: Nutrition.total(entries(on: LocalDay.key())), settings: settings)
    }
}
