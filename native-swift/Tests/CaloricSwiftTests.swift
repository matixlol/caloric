import XCTest
import UIKit
@testable import CaloricSwift

@MainActor
final class CaloricSwiftTests: XCTestCase {
    private var folder: URL!
    override func setUp() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: folder) }
    private func food() -> SearchFood {
        SearchFood(id: "chicken", canonicalKey: "mfp:chicken", source: "mfp", sourceLabel: "MFP", name: "Chicken", serving: "100 g", nutrition: Nutrition(calories: 165, protein: 31, carbs: 0, fat: 3.6))
    }
    func testQuarterPortionsAndMacroTotals() {
        XCTAssertEqual(Portion.sanitize(-10), 0.25)
        XCTAssertEqual(Portion.sanitize(.nan), 1)
        XCTAssertEqual(Portion.sanitize(1.38), 1.5)
        XCTAssertEqual(Portion.label(1.25), "1 1/4 portions")
        XCTAssertEqual(food().nutrition?.multiplied(by: 2).calories, 330)
        XCTAssertEqual(UserSettings().proteinGoal, 188)
        XCTAssertEqual(UserSettings().fatGoal, 56)
        XCTAssertFalse(UserSettings(calorieGoal: 2500, macroProteinPct: 20, macroCarbsPct: 50, macroFatPct: 20).isValid)
    }

    func testDragGeometryReadsCurrentScrollPositionAndRowOrderOnDemand() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        let scroll = UIScrollView(frame: window.bounds)
        scroll.contentSize = CGSize(width: 320, height: 1200)
        window.addSubview(scroll)
        let meal = UIView(frame: CGRect(x: 20, y: 400, width: 280, height: 200))
        scroll.addSubview(meal)
        let table = UITableView(frame: CGRect(x: 0, y: 60, width: 280, height: 100), style: .plain)
        let source = GeometryTableSource()
        table.dataSource = source
        table.rowHeight = 50
        table.isScrollEnabled = false
        meal.addSubview(table)
        table.reloadData(); table.layoutIfNeeded()
        let geometry = DiaryGeometry()
        geometry.registerMeal(.lunch, view: meal)
        geometry.registerRows(meal: .lunch, table: table, ids: ["first", "second"])
        let before = geometry.snapshot()
        scroll.contentOffset.y = 125
        let after = geometry.snapshot()
        XCTAssertEqual(try XCTUnwrap(after.rows["first"]).minY, try XCTUnwrap(before.rows["first"]).minY - 125, accuracy: 0.1)
        XCTAssertEqual(try XCTUnwrap(after.meals[.lunch]).minY, try XCTUnwrap(before.meals[.lunch]).minY - 125, accuracy: 0.1)
        geometry.registerRows(meal: .lunch, table: table, ids: ["second", "first"])
        let reordered = geometry.snapshot()
        XCTAssertEqual(reordered.rows["second"], after.rows["first"])
        XCTAssertEqual(reordered.rows["first"], after.rows["second"])
        geometry.removeRows(meal: .lunch, table: table)
        geometry.removeMeal(.lunch, view: meal)
        XCTAssertEqual(geometry.snapshot(), DiaryLayout())
    }

    private final class GeometryTableSource: NSObject, UITableViewDataSource {
        func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 2 }
        func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell { UITableViewCell() }
    }
    func testBackendPayloadDoesNotIncludeLocalDirtyFlag() throws {
        let entry = FoodEntry(meal: .lunch, foodName: "Chicken", portion: 1, nutrition: food().nutrition, createdAt: 1, dateKey: "2026-10-07", sortIndex: 0)
        let row = FoodRecord(id: "food_entry_test", data: entry, updatedAt: 2, dirty: true)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(PushRequest(foodEntries: [row], settings: nil))) as? [String: Any])
        let rows = try XCTUnwrap(json["foodEntries"] as? [[String: Any]])
        XCTAssertNil(rows[0]["dirty"])
        let data = try XCTUnwrap(rows[0]["data"] as? [String: Any])
        XCTAssertEqual(data["foodName"] as? String, "Chicken")
        XCTAssertEqual(data["meal"] as? String, "lunch")
    }
    func testStoragePersistsAndAccountsStayIsolated() async throws {
        let store = AppStore(directory: folder, syncEnabled: false)
        await store.activate(userID: "account-a")
        let row = try store.add(food: food(), meal: .lunch)
        await store.activate(userID: "account-b")
        XCTAssertTrue(store.entries.isEmpty)
        await store.activate(userID: "account-a")
        XCTAssertEqual(store.entries.first?.id, row.id)
        XCTAssertTrue(store.dirty)
        try store.delete(id: row.id)
        await store.activate(userID: "account-a")
        XCTAssertTrue(store.entries.isEmpty)
        XCTAssertNotNil(store.records.first?.deletedAt)
        XCTAssertTrue(store.records.first?.dirty == true)
    }
    func testStaleBootstrapAndAcknowledgementDoNotEraseLocalEdit() async throws {
        let store = AppStore(directory: folder, syncEnabled: false)
        await store.activate(userID: "account-a")
        let row = try store.add(food: food(), meal: .lunch)
        let sent = PushRequest(foodEntries: [row], settings: nil)
        try store.update(id: row.id) { $0.portion = 2 }
        try store.acknowledge(sent, response: PushResponse(acceptedFoodEntryIds: [row.id], acceptedSettings: false))
        var remote = row; remote.dirty = false; remote.updatedAt += 100
        try store.merge(BootstrapResponse(foodEntries: [remote], settings: nil))
        XCTAssertEqual(store.entries.first?.data.portion, 2)
        XCTAssertTrue(store.records.first?.dirty == true)
    }
    func testDropMovesFoodAndAssignsStableMealOrder() async throws {
        let store = AppStore(directory: folder, syncEnabled: false)
        await store.activate(userID: "account-a")
        let first = try store.add(food: food(), meal: .lunch)
        let second = try store.add(food: food(), meal: .dinner)
        try store.move(id: first.id, to: .dinner, day: LocalDay.key(), before: second.id)
        XCTAssertTrue(store.entries(on: LocalDay.key(), meal: .lunch).isEmpty)
        XCTAssertEqual(store.entries(on: LocalDay.key(), meal: .dinner).map(\.id), [first.id, second.id])
        XCTAssertEqual(store.entries(on: LocalDay.key(), meal: .dinner).map { $0.data.sortIndex }, [0, 1])
    }
    func testMovingDeletedFoodDoesNotResurrectIt() async throws {
        let store = AppStore(directory: folder, syncEnabled: false)
        await store.activate(userID: "account-a")
        let row = try store.add(food: food(), meal: .lunch)
        try store.delete(id: row.id)
        try store.move(id: row.id, to: .dinner, day: LocalDay.key())
        XCTAssertTrue(store.entries.isEmpty)
        XCTAssertEqual(store.records.first?.data.meal, .lunch)
    }
    func testNoOpPortionUpdateDoesNotDirtySynchronizedRecord() async throws {
        let store = AppStore(directory: folder, syncEnabled: false)
        await store.activate(userID: "account-a")
        let row = try store.add(food: food(), meal: .lunch)
        try store.acknowledge(PushRequest(foodEntries: [row], settings: nil), response: PushResponse(acceptedFoodEntryIds: [row.id], acceptedSettings: false))
        try store.update(id: row.id) { $0.portion = 1 }
        XCTAssertFalse(store.dirty)
        XCTAssertEqual(store.records.first?.updatedAt, row.updatedAt)
    }
    func testSSEMultilineAndFinalFrame() throws {
        var decoder = SSEDecoder()
        XCTAssertNil(decoder.append(": keepalive"))
        XCTAssertNil(decoder.append("data: {\"type\":\"event\","))
        XCTAssertNil(decoder.append("data: \"event\":{\"kind\":\"assistant-delta\",\"text\":\"Hello\"}}"))
        let payload = try JSONDecoder().decode(StreamPayload.self, from: XCTUnwrap(decoder.append("")))
        XCTAssertEqual(payload.event?.text, "Hello")
        XCTAssertNil(decoder.append("data: {\"type\":\"status\",\"status\":\"ready\"}"))
        XCTAssertNotNil(decoder.flush())
        XCTAssertNil(decoder.flush())
    }
    func testSmallMacroSectionsStayReadableAndSumToOne() {
        let shares = EntryDetailsView.macroShares([124, 0, 32.4])
        XCTAssertEqual(shares.reduce(0, +), 1, accuracy: 0.0001)
        XCTAssertGreaterThanOrEqual(shares[1], 0.2)
        XCTAssertEqual(EntryDetailsView.macroShares([0, 0, 0]), [1.0 / 3, 1.0 / 3, 1.0 / 3])
    }
}
