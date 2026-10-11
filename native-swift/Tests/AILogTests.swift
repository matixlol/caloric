import XCTest
@testable import CaloricSwift

@MainActor
final class AILogTests: XCTestCase {
    private var transport: URLSession!
    private var store: AppStore!
    private var folder: URL!
    private var chat: AILogService!

    override func setUp() async throws {
        AIHTTPStub.set([])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AIHTTPStub.self]
        transport = URLSession(configuration: configuration)
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        store = AppStore(directory: folder, syncEnabled: false)
        await store.activate(userID: "account-a")
        let api = APIClient(baseURL: URL(string: "https://backend.example")!, session: transport) { _, _ in "test-cookie" }
        chat = AILogService(api: api, session: transport, requestTimeout: .seconds(2))
        chat.reset(accountID: "account-a")
    }

    override func tearDown() async throws {
        chat.reset(accountID: nil)
        transport.invalidateAndCancel()
        await store.activate(userID: nil)
        try? FileManager.default.removeItem(at: folder)
        AIHTTPStub.set([])
    }

    private func waitUntil(_ condition: () -> Bool, timeout: TimeInterval = 3) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), "AI operation did not reach the expected state")
    }

    private let sessionReply = AIHTTPStub.Reply(body: #"{"sessionId":"session-a"}"#)
    private let prefix = "data: {\"type\":\"turn\",\"turnId\":\"turn-a\"}\n\ndata: {\"type\":\"event\",\"event\":{\"kind\":\"assistant\",\"text\":\"Ready 🍎\"},\"seq\":1}\n\n"

    func testReadyEndsLoadingBeforeConnectionClosesAndAllowsAnotherMessage() async throws {
        AIHTTPStub.set([sessionReply, .init(body: prefix + "data: {\"type\":\"status\",\"status\":\"ready\"}\n\n", finish: false), .init(body: prefix + "data: [DONE]\n\n")])
        chat.submit("First message", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertNil(chat.error)
        XCTAssertNil(chat.activeTurnID)
        XCTAssertEqual(chat.messages.last?.text, "Ready 🍎")
        chat.submit("Second message", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertNil(chat.error)
        XCTAssertEqual(chat.messages.filter { $0.role == "user" }.count, 2)
        XCTAssertEqual(AIHTTPStub.requests.map { $0.url!.path }, ["/ai/session", "/ai/turn", "/ai/turn"])
    }

    func testDoneMarkerEndsLoadingWithoutReadyOrConnectionClose() async throws {
        AIHTTPStub.set([sessionReply, .init(body: prefix + "data: [DONE]\n\n", finish: false)])
        chat.submit("Message", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertNil(chat.error)
        XCTAssertNil(chat.activeTurnID)
    }

    func testJSONDoneEndsLoadingWithoutConnectionClose() async throws {
        AIHTTPStub.set([sessionReply, .init(body: prefix + "data: {\"type\":\"done\"}\n\n", finish: false)])
        chat.submit("Message", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertNil(chat.error)
        XCTAssertNil(chat.activeTurnID)
    }

    func testHungStreamTimesOutAndRetrySucceeds() async throws {
        AIHTTPStub.set([sessionReply, .init(body: prefix + ": heartbeat\n\n", finish: false), .init(body: prefix + "data: [DONE]\n\n")])
        chat.submit("Message", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertTrue(chat.error?.contains("took too long") == true)
        XCTAssertNil(chat.activeTurnID)
        chat.submit("Retry", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertNil(chat.error)
        XCTAssertEqual(chat.messages.last?.text, "Ready 🍎")
    }

    func testHungSessionCreationAlsoTimesOut() async throws {
        AIHTTPStub.set([.init(body: "", finish: false)])
        chat.submit("Message", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertTrue(chat.error?.contains("took too long") == true)
        XCTAssertEqual(AIHTTPStub.requests.count, 1)
    }

    func testBackgroundCancellationPreservesTurnAndResumesFromCursor() async throws {
        AIHTTPStub.set([sessionReply, .init(body: prefix, finish: false), .init(body: prefix + "data: [DONE]\n\n")])
        chat.submit("Message", store: store)
        try await waitUntil { chat.appliedSequence == 1 }
        chat.setForeground(false)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(chat.activeTurnID, "turn-a")
        XCTAssertNil(chat.error)
        chat.setForeground(true)
        try await waitUntil { !chat.streaming }
        XCTAssertNil(chat.error)
        XCTAssertEqual(chat.messages.filter { $0.role == "assistant" }.count, 1)
        XCTAssertEqual(AIHTTPStub.requests.last?.url?.path, "/ai/turn/turn-a/stream")
        XCTAssertEqual(AIHTTPStub.requests.last?.url?.query, "cursor=1")
    }

    func testServerErrorStopsLoadingAndKeepsExplanation() async throws {
        AIHTTPStub.set([sessionReply, .init(body: prefix + "data: {\"type\":\"error\",\"message\":\"Please try again\"}\n\n", finish: false)])
        chat.submit("Message", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertTrue(chat.error?.contains("Please try again") == true)
        XCTAssertNil(chat.activeTurnID)
    }

    func testSwitchingAwayAndBackDoesNotLetCancelledTaskOverwriteNewOperation() async throws {
        AIHTTPStub.set([sessionReply, .init(body: prefix, finish: false), sessionReply, .init(body: prefix + "data: [DONE]\n\n")])
        chat.submit("Old account message", store: store)
        try await waitUntil { chat.activeTurnID != nil }
        chat.reset(accountID: "account-b")
        chat.reset(accountID: "account-a")
        chat.submit("New account message", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertNil(chat.error)
        XCTAssertEqual(chat.messages.filter { $0.role == "user" }.map(\.text), ["New account message"])
        XCTAssertEqual(chat.messages.last?.text, "Ready 🍎")
    }
}

private final class AIHTTPStub: URLProtocol, @unchecked Sendable {
    struct Reply { var status = 200; var body: String; var finish = true }
    private static let lock = NSLock()
    private static var replies: [Reply] = []
    private static var captured: [URLRequest] = []
    static var requests: [URLRequest] { lock.withLock { captured } }
    static func set(_ values: [Reply]) { lock.withLock { replies = values; captured = [] } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reply: Reply? = Self.lock.withLock {
            Self.captured.append(request)
            return Self.replies.isEmpty ? nil : Self.replies.removeFirst()
        }
        guard let reply, let url = request.url else { client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return }
        let headers = ["Content-Type": url.path == "/ai/session" ? "application/json" : "text/event-stream"]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        if reply.finish { client?.urlProtocolDidFinishLoading(self) }
    }
    override func stopLoading() { }
}
