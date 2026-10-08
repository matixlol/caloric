import XCTest
@testable import CaloricSwift

@MainActor
final class FeatureParityTests: XCTestCase {
    private var folder: URL!
    override func setUp() { folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    override func tearDown() { try? FileManager.default.removeItem(at: folder) }
    private func ingredient(_ id: String = "ingredient") -> RecipeItem {
        RecipeItem(id: id, foodName: "Chicken", serving: "100 g", portion: 2, nutrition: Nutrition(calories: 165, protein: 31, carbs: 0, fat: 3.6, sodiumMg: 74))
    }
    func testRecipeSnapshotsRemainIndependentFromReusableRecipeAndDeletion() async throws {
        let store = AppStore(directory: folder, syncEnabled: false); await store.activate(userID: "a")
        let recipe = try store.createRecipe(name: "Lunch", items: [ingredient()])
        let entry = try store.logRecipe(recipe, meal: .lunch, day: LocalDay.key(), portion: 1.5)
        XCTAssertEqual(entry.data.nutrition?.calories, 330)
        XCTAssertEqual(Nutrition.total(store.entries).calories, 495)
        try store.updateRecipe(id: recipe.id) { $0.items[0].portion = 3; $0.name = "Updated lunch" }
        XCTAssertEqual(store.entries.first?.data.recipeItems?.first?.portion, 2)
        try store.updateLoggedRecipe(id: entry.id, items: [ingredient("separate")])
        XCTAssertEqual(store.recipes.first?.data.items.first?.portion, 3)
        try store.deleteRecipe(id: recipe.id)
        XCTAssertTrue(store.recipes.isEmpty)
        XCTAssertEqual(store.entries.count, 1)
        await store.activate(userID: "a")
        XCTAssertTrue(store.recipes.isEmpty)
        XCTAssertEqual(store.entries.first?.data.recipeId, recipe.id)
        XCTAssertEqual(store.entries.first?.data.recipeItems?.first?.id, "separate")
    }
    func testRecipeDuplicationAndAccountIsolationPersist() async throws {
        let store = AppStore(directory: folder, syncEnabled: false); await store.activate(userID: "a")
        let recipe = try store.createRecipe(name: "Lunch", items: [ingredient()])
        let copy = try XCTUnwrap(store.duplicateRecipe(id: recipe.id))
        XCTAssertEqual(copy.data.name, "Lunch copy")
        XCTAssertNotEqual(copy.data.items.first?.id, recipe.data.items.first?.id)
        await store.activate(userID: "b"); XCTAssertTrue(store.recipes.isEmpty)
        await store.activate(userID: "a"); XCTAssertEqual(store.recipes.count, 2)
        XCTAssertTrue(store.recipeRecords.allSatisfy(\.dirty))
    }
    func testRecipeAcknowledgementAndRejectedWriteProtectNewerLocalEdit() async throws {
        let store = AppStore(directory: folder, syncEnabled: false); await store.activate(userID: "a")
        let row = try store.createRecipe(name: "Lunch", items: [ingredient()])
        let sent = PushRequest(foodEntries: [], settings: nil, recipes: [row])
        try store.updateRecipe(id: row.id) { $0.name = "New local name" }
        try store.acknowledge(sent, response: PushResponse(acceptedFoodEntryIds: [], acceptedSettings: false, acceptedRecipeIds: [row.id]))
        var remote = row; remote.dirty = false; remote.updatedAt += 100; remote.data.name = "Another device"
        try store.merge(BootstrapResponse(foodEntries: [], settings: nil, recipes: [remote]), rejected: sent)
        XCTAssertEqual(store.recipes.first?.data.name, "New local name")
        XCTAssertTrue(store.recipeRecords.first?.dirty == true)
        let rejected = PushRequest(foodEntries: [], settings: nil, recipes: store.recipeRecords)
        try store.merge(BootstrapResponse(foodEntries: [], settings: nil, recipes: [remote]), rejected: rejected)
        XCTAssertEqual(store.recipes.first?.data.name, "Another device")
        XCTAssertFalse(store.dirty)
    }
    func testRemoteRecipeDeletionAndRejectedTombstoneSurviveReopening() async throws {
        let store = AppStore(directory: folder, syncEnabled: false); await store.activate(userID: "a")
        let row = try store.createRecipe(name: "Lunch", items: [ingredient()])
        let sent = PushRequest(foodEntries: [], settings: nil, recipes: [row])
        try store.acknowledge(sent, response: PushResponse(acceptedFoodEntryIds: [], acceptedSettings: false, acceptedRecipeIds: [row.id]))
        try store.merge(BootstrapResponse(foodEntries: [], settings: nil, recipes: []))
        await store.activate(userID: "a"); XCTAssertTrue(store.recipes.isEmpty)
        XCTAssertNotNil(store.recipeRecords.first?.deletedAt)
        let pending = try store.createRecipe(name: "Rejected")
        try store.merge(BootstrapResponse(foodEntries: [], settings: nil), rejected: PushRequest(foodEntries: [], settings: nil, recipes: [pending]))
        XCTAssertTrue(store.recipes.isEmpty); XCTAssertFalse(store.dirty)
    }
    func testRecipeAggregatesAllNutrientsAndPreservesUnknownValues() {
        let total = Nutrition.aggregate([ingredient(), RecipeItem(id: "unknown", foodName: "Unknown", portion: 1)])
        XCTAssertEqual(total.calories, 330); XCTAssertEqual(total.protein, 62); XCTAssertEqual(total.carbs, 0)
        XCTAssertEqual(total.sodiumMg, 148); XCTAssertNil(total.fiber)
        XCTAssertNil(Nutrition.aggregate([]).calories)
        XCTAssertFalse(Nutrition(calories: 100).hasCalorieMismatch)
        XCTAssertTrue(Nutrition(calories: 100, protein: 20, carbs: 20, fat: 20).hasCalorieMismatch)
        XCTAssertFalse(Nutrition(calories: 100, protein: 25, carbs: 0, fat: 0).hasCalorieMismatch)
    }
    func testQuickAddValidationAndOptionalMacros() {
        XCTAssertEqual(QuickAdd.calories("250.6"), 251)
        for invalid in ["", "NaN", "infinity", "0", "-5", "10001"] { XCTAssertNil(QuickAdd.calories(invalid)) }
        XCTAssertNil(QuickAdd.nutrition(calories: "250", protein: "-1", carbs: "", fat: ""))
        let nutrition = QuickAdd.nutrition(calories: "250", protein: "0", carbs: "12.36", fat: "")
        XCTAssertEqual(nutrition?.protein, 0); XCTAssertEqual(nutrition?.carbs, 12.4); XCTAssertNil(nutrition?.fat)
    }
    func testBarcodeNormalizesUPCAndRejectsInvalidCameraInput() {
        XCTAssertEqual(BarcodeScanner.normalize("012345678905"), "0012345678905")
        XCTAssertEqual(BarcodeScanner.normalize("12345678"), "12345678")
        XCTAssertEqual(BarcodeScanner.normalize(" 779-1234567890 "), "7791234567890")
        for invalid in ["", "1234567", "12345678901234", "QR code", "١٢٣٤٥٦٧٨"] { XCTAssertNil(BarcodeScanner.normalize(invalid)) }
    }
    func testSearchInterleavesBeyondFirstPageWithoutCanonicalDuplicates() {
        func food(_ id: Int) -> SearchFood { SearchFood(id: "\(id)", canonicalKey: "\(id)", source: "mfp", sourceLabel: "MFP", name: "Food \(id)") }
        let result = FoodSearchView.interleave([(0..<40).map(food), (20..<60).map(food)])
        XCTAssertEqual(result.count, 60); XCTAssertEqual(Set(result.map(\.canonicalKey)).count, 60)
        XCTAssertEqual(Array(result.prefix(4).map(\.id)), ["0", "20", "1", "21"])
    }
    func testWidgetPercentagesCanExceedGoalAndUseSelectedMacroRatios() {
        let snapshot = WidgetSnapshot(nutrition: Nutrition(calories: 3300, protein: 300, carbs: 0, fat: 0), settings: UserSettings(calorieGoal: 2200), day: "2026-10-07")
        XCTAssertEqual(snapshot.calorieProgress, 150); XCTAssertEqual(snapshot.proteinProgress, 182)
        XCTAssertEqual(snapshot.dateKey, "2026-10-07")
    }
    func testFriendDayDecodesFlatBackendEntriesAndRecipeMetadata() throws {
        let row = FoodEntry(meal: .lunch, foodName: "Recipe", portion: 2, createdAt: 1, dateKey: "2026-10-07", sortIndex: 0, recipeId: "recipe", recipeItems: [ingredient()])
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(row)) as? [String: Any]); json["id"] = "food"; json["updatedAt"] = 2
        let food = try JSONDecoder().decode(FriendFood.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(food.record.data, row); XCTAssertFalse(food.record.dirty)
    }
    func testAIResumeReplaysCommittedEventsWithoutDuplicatesAndKeepsSeparateMessages() throws {
        let chat = AILogService(); chat.reset(accountID: "a")
        func frame(_ json: String) throws { try chat.process(Data(json.utf8), userMessageID: "user") }
        try frame(#"{"type":"turn","turnId":"turn"}"#)
        try frame(#"{"type":"event","event":{"kind":"assistant-delta","text":"Partial"}}"#)
        try frame(#"{"type":"event","seq":1,"event":{"kind":"assistant","text":"Complete"}}"#)
        try frame(#"{"type":"event","seq":1,"event":{"kind":"assistant","text":"Complete"}}"#)
        try frame(#"{"type":"event","seq":2,"event":{"kind":"search","query":"Chicken","foods":[]}}"#)
        try frame(#"{"type":"event","event":{"kind":"assistant","text":"New partial"}}"#)
        try frame(#"{"type":"event","event":{"kind":"assistant-delta","text":" continued"}}"#)
        try frame(#"{"type":"event","seq":3,"event":{"kind":"assistant","text":"Second complete"}}"#)
        XCTAssertEqual(chat.messages.map(\.text), ["Complete", "", "Second complete"])
        XCTAssertEqual(chat.appliedSequence, 3)
        try frame(#"{"type":"status","status":"ready"}"#); XCTAssertNil(chat.activeTurnID)
        try chat.process(Data("[DONE]".utf8), userMessageID: "user")
        chat.reset(accountID: "b"); XCTAssertTrue(chat.messages.isEmpty); XCTAssertEqual(chat.appliedSequence, -1)
    }
    func testSSEByteParsingPreservesBlankFramesCRLFUnicodeAndFinalFrame() throws {
        let stream = "data: {\"type\":\"event\",\"event\":{\"kind\":\"assistant-delta\",\"text\":\"🍎\"}}\r\n\r\n: ping\n\ndata: {\"type\":\"status\",\"status\":\"ready\"}\n\ndata: {\"type\":\"done\"}"
        var decoder = SSEByteDecoder(), frames: [StreamPayload] = []
        for byte in stream.utf8 { if let data = decoder.append(byte) { frames.append(try JSONDecoder().decode(StreamPayload.self, from: data)) } }
        if let data = decoder.flush() { frames.append(try JSONDecoder().decode(StreamPayload.self, from: data)) }
        XCTAssertEqual(frames.map(\.type), ["event", "status", "done"])
        XCTAssertEqual(frames[0].event?.text, "🍎")
    }
}
