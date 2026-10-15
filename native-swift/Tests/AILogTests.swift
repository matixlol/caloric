import UIKit
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

    // MARK: Next assistant

    private func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
        return data
    }

    func testMultipartBodyIncludesEachImageAsJPEGField() {
        let body = AILogService.multipartBody(boundary: "B", sessionID: "session-a", text: "Lunch", audio: nil, images: [Data("one".utf8), Data("two".utf8)])
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertEqual(text, "--B\r\nContent-Disposition: form-data; name=\"sessionId\"\r\n\r\nsession-a\r\n"
            + "--B\r\nContent-Disposition: form-data; name=\"actionType\"\r\n\r\nuser-message\r\n"
            + "--B\r\nContent-Disposition: form-data; name=\"message\"\r\n\r\nLunch\r\n"
            + "--B\r\nContent-Disposition: form-data; name=\"image\"; filename=\"photo-1.jpg\"\r\nContent-Type: image/jpeg\r\n\r\none\r\n"
            + "--B\r\nContent-Disposition: form-data; name=\"image\"; filename=\"photo-2.jpg\"\r\nContent-Type: image/jpeg\r\n\r\ntwo\r\n"
            + "--B--\r\n")
    }

    func testMultipartAudioOnlyBodyMatchesClassicEncoding() {
        let audio = Data("m4a".utf8)
        var classic = Data("--B\r\nContent-Disposition: form-data; name=\"sessionId\"\r\n\r\ns\r\n--B\r\nContent-Disposition: form-data; name=\"actionType\"\r\n\r\nuser-message\r\n".utf8)
        classic.append(Data("--B\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"voice.m4a\"\r\nContent-Type: audio/m4a\r\n\r\n".utf8))
        classic.append(audio); classic.append(Data("\r\n--B--\r\n".utf8))
        XCTAssertEqual(AILogService.multipartBody(boundary: "B", sessionID: "s", text: "", audio: audio, images: []), classic)
        let both = String(decoding: AILogService.multipartBody(boundary: "B", sessionID: "s", text: "", audio: audio, images: [Data("jpg".utf8)]), as: UTF8.self)
        XCTAssertTrue(both.contains("filename=\"voice.m4a\"\r\nContent-Type: audio/m4a\r\n\r\nm4a\r\n--B\r\nContent-Disposition: form-data; name=\"image\"; filename=\"photo-1.jpg\""))
    }

    func testVariantResolutionPrefersOverrideThenServerThenClassic() throws {
        XCTAssertEqual(AssistantLabs.resolve(override: nil, server: nil), .classic)
        XCTAssertEqual(AssistantLabs.resolve(override: nil, server: .next), .next)
        XCTAssertEqual(AssistantLabs.resolve(override: .classic, server: .next), .classic)
        XCTAssertEqual(AssistantLabs.resolve(override: .next, server: .classic), .next)
        XCTAssertNil(AssistantLabs.sessionVariant(override: nil, server: nil))
        XCTAssertEqual(AssistantLabs.sessionVariant(override: .classic, server: .next), .classic)
        XCTAssertEqual(AssistantLabs.sessionVariant(override: nil, server: .next), .next)
        let suite = "caloric-labs-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let labs = AssistantLabs(defaults: defaults, arguments: [])
        XCTAssertEqual(labs.effective, .classic)
        labs.override = .next
        XCTAssertEqual(defaults.string(forKey: AssistantLabs.overrideKey), "next")
        XCTAssertEqual(AssistantLabs(defaults: defaults, arguments: []).effective, .next)
        labs.override = nil
        XCTAssertNil(defaults.string(forKey: AssistantLabs.overrideKey))
        XCTAssertEqual(AssistantLabs(defaults: defaults, arguments: ["-ai-variant-next"]).effective, .next)
    }

    func testLabsLoadsAccountDefaultAndFailuresStayClassic() async throws {
        let suite = "caloric-labs-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let api = APIClient(baseURL: URL(string: "https://backend.example")!, session: transport) { _, _ in "test-cookie" }
        let labs = AssistantLabs(defaults: defaults, arguments: [])
        AIHTTPStub.set([.init(body: #"{"variant":"next"}"#)])
        await labs.load(accountID: "account-a", api: api)
        XCTAssertEqual(AIHTTPStub.requests.first?.url?.path, "/ai/config")
        XCTAssertEqual(labs.serverVariant, .next)
        XCTAssertEqual(labs.effective, .next)
        await labs.load(accountID: "account-a", api: api)
        XCTAssertEqual(AIHTTPStub.requests.count, 1, "Config is fetched once per account")
        AIHTTPStub.set([.init(status: 500, body: "{}")])
        await labs.load(accountID: "account-b", api: api)
        XCTAssertEqual(labs.serverVariant, .classic)
        XCTAssertEqual(labs.effective, .classic)
    }

    func testClassicSessionBodyOmitsVariant() async throws {
        AIHTTPStub.set([sessionReply, .init(body: prefix + "data: [DONE]\n\n")])
        chat.submit("Message", store: store)
        try await waitUntil { !chat.streaming }
        let session = try XCTUnwrap(JSONSerialization.jsonObject(with: body(AIHTTPStub.requests[0])) as? [String: Any])
        XCTAssertNotNil(session["recentLogs"])
        XCTAssertNil(session["variant"])
        XCTAssertEqual(AIHTTPStub.requests[1].value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testNextSessionSendsVariantAndPhotosAsMultipart() async throws {
        chat.configure(variant: .next, requested: .next)
        AIHTTPStub.set([.init(body: #"{"sessionId":"session-a","status":"ready","variant":"next"}"#), .init(body: prefix + "data: [DONE]\n\n")])
        let photo = AssistantImage(jpeg: Data("jpeg-bytes".utf8), preview: UIImage())
        chat.submit("", store: store, images: [photo])
        XCTAssertEqual(chat.messages.first?.images.count, 1)
        XCTAssertEqual(AILogService.activity(messages: chat.messages, streaming: true), "Looking at your photo…")
        try await waitUntil { !chat.streaming }
        XCTAssertNil(chat.error)
        let session = try XCTUnwrap(JSONSerialization.jsonObject(with: body(AIHTTPStub.requests[0])) as? [String: Any])
        XCTAssertEqual(session["variant"] as? String, "next")
        XCTAssertEqual(chat.sessionVariant, .next)
        let turn = AIHTTPStub.requests[1]
        XCTAssertTrue(turn.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
        let text = String(decoding: body(turn), as: UTF8.self)
        XCTAssertTrue(text.contains("name=\"image\"; filename=\"photo-1.jpg\"\r\nContent-Type: image/jpeg\r\n\r\njpeg-bytes\r\n"))
        XCTAssertFalse(text.contains("name=\"message\""))
        XCTAssertFalse(text.contains("name=\"audio\""))
    }

    func testPhotosAreNotSentToAClassicSession() async throws {
        chat.configure(variant: .next, requested: .next)
        AIHTTPStub.set([.init(body: #"{"sessionId":"session-a","variant":"classic"}"#)])
        chat.submit("", store: store, images: [AssistantImage(jpeg: Data("x".utf8), preview: UIImage())])
        try await waitUntil { !chat.streaming }
        XCTAssertTrue(chat.error?.contains("Photos") == true)
        XCTAssertEqual(AIHTTPStub.requests.count, 1)
    }

    func testChangingEffectiveVariantStartsANewChat() async throws {
        AIHTTPStub.set([sessionReply, .init(body: prefix + "data: [DONE]\n\n"), sessionReply, .init(body: prefix + "data: [DONE]\n\n")])
        chat.submit("Message", store: store)
        try await waitUntil { !chat.streaming }
        chat.configure(variant: .classic, requested: .classic)
        XCTAssertFalse(chat.messages.isEmpty, "Same effective variant keeps the conversation")
        chat.configure(variant: .next, requested: .next)
        XCTAssertTrue(chat.messages.isEmpty)
        chat.submit("Again", store: store)
        try await waitUntil { !chat.streaming }
        XCTAssertEqual(AIHTTPStub.requests.map { $0.url!.path }, ["/ai/session", "/ai/turn", "/ai/session", "/ai/turn"])
    }

    func testApproveUsesEditedPortionAndMeal() throws {
        let food = SearchFood(id: "egg", canonicalKey: "egg", source: "mfp", sourceLabel: "MFP", name: "Egg", nutrition: Nutrition(calories: 90))
        let message = ChatMessage(kind: "approval", toolCallID: "call", suggestions: [
            FoodSuggestion(suggestionId: "s1", resultId: "r1", meal: .breakfast, portion: 1, reason: "", food: food),
            FoodSuggestion(suggestionId: "s2", resultId: "r2", meal: .breakfast, portion: 1, reason: "", food: food),
        ])
        chat.messages = [message]
        XCTAssertTrue(chat.approve(messageID: message.id, suggestionID: "s1", approved: true, store: store, portion: 1.3, meal: .lunch))
        XCTAssertTrue(chat.approve(messageID: message.id, suggestionID: "s2", approved: false, store: store))
        XCTAssertFalse(chat.approve(messageID: message.id, suggestionID: "s1", approved: true, store: store), "Decisions are final")
        XCTAssertEqual(store.entries.count, 1)
        XCTAssertEqual(store.entries.first?.data.meal, .lunch)
        XCTAssertEqual(store.entries.first?.data.portion, 1.25)
        XCTAssertEqual(chat.messages[0].suggestions[0].portion, 1.25)
        XCTAssertEqual(chat.messages[0].suggestions[0].output?.approved, true)
        XCTAssertEqual(chat.messages[0].suggestions[1].output?.approved, false)
    }

    func testActivityDescribesTheLatestStep() {
        let voice = ChatMessage(kind: "audio", role: "user", text: "Voice message")
        XCTAssertNil(AILogService.activity(messages: [voice], streaming: false))
        XCTAssertEqual(AILogService.activity(messages: [voice], streaming: true), "Listening to your note…")
        XCTAssertEqual(AILogService.activity(messages: [ChatMessage(kind: "text", role: "user", text: "Hi")], streaming: true), "Thinking…")
        let search = ChatMessage(kind: "search", query: "banana")
        XCTAssertEqual(AILogService.activity(messages: [voice, search], streaming: true), "Searching for “banana”…")
        let reply = ChatMessage(kind: "text", text: "Here")
        XCTAssertNil(AILogService.activity(messages: [voice, reply], streaming: true, writingID: reply.id))
        XCTAssertEqual(AILogService.activity(messages: [voice, reply], streaming: true), "Thinking…")
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
