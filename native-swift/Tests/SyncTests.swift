import XCTest
@testable import CaloricSwift

@MainActor
final class SyncTests: XCTestCase {
    private var folder: URL!
    override func setUp() { folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    override func tearDown() { try? FileManager.default.removeItem(at: folder); SyncHTTPStub.reset() }

    private func remoteFood() -> FoodRecord {
        FoodRecord(id: "server-food", data: FoodEntry(meal: .breakfast, foodName: "Server breakfast", portion: 1.5,
            nutrition: Nutrition(calories: 200, protein: 10), createdAt: 1_791_388_800_000, dateKey: LocalDay.key(), sortIndex: 0), updatedAt: 1_791_388_800_000)
    }
    private func localFood() -> SearchFood {
        SearchFood(id: "local", canonicalKey: "local", source: "mfp", sourceLabel: "MFP", name: "Local food", nutrition: Nutrition(calories: 100))
    }
    func testActivationDownloadsExistingDiaryAndGoals() async throws {
        let api = SyncStub(snapshot: BootstrapResponse(foodEntries: [remoteFood()], settings: SettingsRecord(data: UserSettings(calorieGoal: 2200), updatedAt: 123)))
        let store = AppStore(api: api, directory: folder)
        await store.activate(userID: "account-a")
        XCTAssertEqual(api.downloadUsers, ["account-a"])
        XCTAssertEqual(store.entries(on: LocalDay.key()).first?.data.foodName, "Server breakfast")
        XCTAssertEqual(Nutrition.total(store.entries).calories, 300)
        XCTAssertEqual(store.settings.calorieGoal, 2200)
        XCTAssertNotNil(store.lastSyncedAt)
        XCTAssertNil(store.syncError)
        XCTAssertFalse(store.dirty)
    }
    func testFailedUploadStillDownloadsServerDataAndPreservesLocalChanges() async throws {
        let api = SyncStub()
        let store = AppStore(api: api, directory: folder)
        await store.activate(userID: "account-a")
        let local = try store.add(food: localFood(), meal: .lunch)
        api.pushError = APIError.response(400, "Invalid sync payload")
        api.snapshot = BootstrapResponse(foodEntries: [remoteFood()], settings: SettingsRecord(data: UserSettings(calorieGoal: 2200), updatedAt: 123))
        await store.synchronize()
        XCTAssertEqual(store.entries.count, 2)
        XCTAssertTrue(store.records.first { $0.id == local.id }?.dirty == true)
        XCTAssertEqual(store.settings.calorieGoal, 2200)
        XCTAssertTrue(store.syncError?.contains("400") == true)
        api.pushError = nil
        api.snapshot.foodEntries.append(store.records.first { $0.id == local.id }!)
        api.snapshot.foodEntries[1].dirty = false
        await store.synchronize()
        XCTAssertFalse(store.dirty)
        XCTAssertNil(store.syncError)
        XCTAssertNotNil(store.lastSyncedAt)
    }
    func testDownloadFailureDoesNotClaimSuccessfulSyncAndRecoveryClearsError() async throws {
        let api = SyncStub()
        api.downloadError = APIError.response(401, "Unauthorized")
        let store = AppStore(api: api, directory: folder)
        await store.activate(userID: "account-a")
        XCTAssertTrue(store.ready)
        XCTAssertNil(store.lastSyncedAt)
        XCTAssertTrue(store.syncError?.contains("401") == true)
        api.downloadError = nil
        api.snapshot.foodEntries = [remoteFood()]
        await store.synchronize()
        XCTAssertNil(store.syncError)
        XCTAssertNotNil(store.lastSyncedAt)
        XCTAssertEqual(store.entries.first?.id, "server-food")
    }
    func testRejectedOlderWriteUsesNewerServerVersionInsteadOfStayingPending() async throws {
        let api = SyncStub()
        let store = AppStore(api: api, directory: folder)
        await store.activate(userID: "account-a")
        let local = try store.add(food: localFood(), meal: .lunch)
        var server = local; server.dirty = false; server.updatedAt += 100; server.data.portion = 3
        api.rejectWrites = true
        api.snapshot.foodEntries = [server]
        await store.synchronize()
        XCTAssertEqual(store.entries.first?.data.portion, 3)
        XCTAssertFalse(store.dirty)
        XCTAssertNil(store.syncError)
    }
    func testServerDeletionRemovesCleanLocalEntryAndSurvivesReopening() async throws {
        let api = SyncStub(snapshot: BootstrapResponse(foodEntries: [remoteFood()], settings: nil))
        let store = AppStore(api: api, directory: folder)
        await store.activate(userID: "account-a")
        XCTAssertEqual(store.entries.count, 1)
        api.snapshot.foodEntries = []
        await store.synchronize()
        XCTAssertTrue(store.entries.isEmpty)
        await store.activate(userID: "account-a")
        XCTAssertTrue(store.entries.isEmpty)
        XCTAssertFalse(store.dirty)
    }
    func testEditMadeDuringRejectedUploadIsNotOverwrittenByBootstrap() async throws {
        let api = SyncStub()
        let store = AppStore(api: api, directory: folder)
        await store.activate(userID: "account-a")
        let local = try store.add(food: localFood(), meal: .lunch)
        var server = local; server.dirty = false; server.updatedAt += 100; server.data.portion = 3
        api.rejectWrites = true
        api.snapshot.foodEntries = [server]
        api.beforePushResponse = { try! store.update(id: local.id) { $0.portion = 2 } }
        await store.synchronize()
        api.beforePushResponse = nil
        XCTAssertEqual(store.entries.first?.data.portion, 2)
        XCTAssertTrue(store.dirty)
        XCTAssertNotNil(store.syncError)
    }
    func testHTTPBootstrapRevalidatesRejectedSessionOnceAndDecodesBackendPayload() async throws {
        let body = #"{"foodEntries":[{"id":"existing-food","data":{"meal":"lunch","foodName":"Existing food","portion":1,"nutrition":{"calories":165},"createdAt":1791388800000,"dateKey":"2026-10-07","sortIndex":0},"updatedAt":1791388800000}],"settings":{"id":"settings","data":{"calorieGoal":2200,"macroProteinPct":30,"macroCarbsPct":50,"macroFatPct":20},"updatedAt":1791388800000}}"#
        SyncHTTPStub.set([(401, #"{"error":"Unauthorized"}"#), (200, body)])
        var cookieRequests: [(String?, Bool)] = []
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [SyncHTTPStub.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let api = APIClient(baseURL: URL(string: "https://backend.example")!, session: session) { user, refresh in
            cookieRequests.append((user, refresh))
            return refresh ? "__Secure-better-auth.session_token=fresh" : "__Secure-better-auth.session_token=cached"
        }
        let payload = try await api.bootstrap(userID: "account-a")
        XCTAssertEqual(cookieRequests.map { $0.0 }, ["account-a", "account-a"])
        XCTAssertEqual(cookieRequests.map { $0.1 }, [false, true])
        XCTAssertEqual(SyncHTTPStub.requests.map { $0.url?.path }, ["/sync/bootstrap", "/sync/bootstrap"])
        XCTAssertEqual(SyncHTTPStub.requests.map { $0.value(forHTTPHeaderField: "Cookie") }, ["__Secure-better-auth.session_token=cached", "__Secure-better-auth.session_token=fresh"])
        XCTAssertEqual(payload.foodEntries.first?.data.foodName, "Existing food")
        XCTAssertEqual(payload.settings?.data.calorieGoal, 2200)
        XCTAssertFalse(payload.foodEntries[0].dirty)
    }
    func testHTTPRepeatedUnauthorizedStopsAfterOneRefresh() async throws {
        SyncHTTPStub.set([(401, #"{"error":"Unauthorized"}"#), (401, #"{"error":"Unauthorized"}"#)])
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [SyncHTTPStub.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let api = APIClient(baseURL: URL(string: "https://backend.example")!, session: session) { _, _ in "__Secure-better-auth.session_token=test" }
        do { _ = try await api.bootstrap(userID: "account-a"); XCTFail("Expected authentication failure") }
        catch { XCTAssertTrue(error.localizedDescription.contains("401")) }
        XCTAssertEqual(SyncHTTPStub.requests.count, 2)
    }
    func testTransientDownloadFailureRecoversWithoutAnotherManualSync() async throws {
        let api = SyncStub(snapshot: BootstrapResponse(foodEntries: [remoteFood()], settings: nil))
        api.transientFailures = 1
        let recovered = expectation(description: "Automatic retry downloads server data")
        api.onDownload = { if api.downloadUsers.count == 2 { recovered.fulfill() } }
        let store = AppStore(api: api, directory: folder, retryDelays: [.milliseconds(10)])
        await store.activate(userID: "account-a")
        XCTAssertNotNil(store.syncError)
        await fulfillment(of: [recovered], timeout: 2)
        api.onDownload = nil
        XCTAssertEqual(store.entries.first?.id, "server-food")
        XCTAssertNil(store.syncError)
        XCTAssertNotNil(store.lastSyncedAt)
    }
    func testPersistentNetworkFailureStopsAfterBoundedRetries() async throws {
        let api = SyncStub()
        api.downloadError = URLError(.timedOut)
        let stopped = expectation(description: "Initial attempt and three retries")
        api.onDownload = { if api.downloadUsers.count == 4 { stopped.fulfill() } }
        let store = AppStore(api: api, directory: folder, retryDelays: [.milliseconds(10), .milliseconds(20), .milliseconds(30)])
        await store.activate(userID: "account-a")
        await fulfillment(of: [stopped], timeout: 2)
        api.onDownload = nil
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(api.downloadUsers.count, 4)
        XCTAssertNotNil(store.syncError)
        XCTAssertNil(store.lastSyncedAt)
        XCTAssertFalse(store.isSyncing)
    }
}

@MainActor
private final class SyncStub: SyncAPI {
    var snapshot: BootstrapResponse
    var pushError: Error?
    var downloadError: Error?
    var downloadUsers: [String] = []
    var rejectWrites = false
    var beforePushResponse: (() -> Void)?
    var onDownload: (() -> Void)?
    var transientFailures = 0
    init(snapshot: BootstrapResponse = BootstrapResponse(foodEntries: [], settings: nil)) { self.snapshot = snapshot }
    func bootstrap(userID: String) async throws -> BootstrapResponse {
        downloadUsers.append(userID)
        onDownload?()
        if transientFailures > 0 { transientFailures -= 1; throw URLError(.networkConnectionLost) }
        if let downloadError { throw downloadError }
        return snapshot
    }
    func push(_ payload: PushRequest, userID: String) async throws -> PushResponse {
        if let pushError { throw pushError }
        beforePushResponse?()
        return PushResponse(acceptedFoodEntryIds: rejectWrites ? [] : payload.foodEntries.map(\.id), acceptedSettings: !rejectWrites && payload.settings != nil)
    }
}

private final class SyncHTTPStub: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var responses: [(Int, String)] = []
    private static var captured: [URLRequest] = []
    static var requests: [URLRequest] { lock.withLock { captured } }
    static func set(_ values: [(Int, String)]) { lock.withLock { responses = values; captured = [] } }
    static func reset() { set([]) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let value: (Int, String)? = Self.lock.withLock {
            Self.captured.append(request)
            return Self.responses.isEmpty ? nil : Self.responses.removeFirst()
        }
        guard let value, let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: value.0, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(value.1.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
