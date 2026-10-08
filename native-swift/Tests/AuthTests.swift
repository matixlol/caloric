import XCTest
@testable import CaloricSwift

@MainActor
final class AuthTests: XCTestCase {
    private var transport: URLSession!
    private var storage: MemoryAuthStorage!
    private var auth: NativeAuth!
    private let userJSON = #"{"id":"account-a","email":"person@example.com","name":"Person"}"#
    override func setUp() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.protocolClasses = [AuthHTTPStub.self]
        transport = URLSession(configuration: config)
        storage = MemoryAuthStorage()
        auth = NativeAuth(baseURL: URL(string: "https://backend.example")!, session: transport, storage: storage)
        AuthHTTPStub.reset()
    }
    override func tearDown() async throws { transport.invalidateAndCancel(); AuthHTTPStub.reset() }

    private func loginReply(_ cookie: String = "signed-original") -> AuthHTTPStub.Reply {
        .init(body: "{\"user\":\(userJSON),\"token\":\"unsigned-body-token\"}", cookie: "__Secure-better-auth.session_token=\(cookie); Path=/; HttpOnly; Secure; SameSite=Lax")
    }
    func testPasswordLoginPersistsSignedCookieAndRestoresSameAccount() async throws {
        AuthHTTPStub.set([loginReply(), .init(body: "{\"user\":\(userJSON),\"session\":{\"id\":\"session-a\"}}")])
        try await auth.signIn(email: "person@example.com", password: "test-password")
        XCTAssertEqual(auth.user?.id, "account-a")
        let cookie = try await auth.cookie(expectedUserID: "account-a", refresh: false)
        XCTAssertEqual(cookie, "__Secure-better-auth.session_token=signed-original")
        XCTAssertNotNil(storage.data)
        let restored = NativeAuth(baseURL: auth.baseURL, session: transport, storage: storage)
        await restored.restore()
        XCTAssertTrue(restored.isLoaded)
        XCTAssertEqual(restored.user?.id, "account-a")
        let requests = AuthHTTPStub.requests
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/auth/sign-in/email", "/api/auth/get-session"])
        XCTAssertEqual(requests[1].url?.query, "disableCookieCache=true")
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Cookie"), "__Secure-better-auth.session_token=signed-original")
        XCTAssertNil(requests[1].value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Origin"), "https://backend.example")
    }
    func testEmailCodeUsesCurrentBackendEndpointsAndSignedSession() async throws {
        AuthHTTPStub.set([.init(body: #"{"success":true}"#), loginReply()])
        try await auth.sendCode(email: "person@example.com")
        try await auth.signIn(email: "person@example.com", code: "123456")
        XCTAssertEqual(AuthHTTPStub.requests.map { $0.url?.path }, ["/api/auth/email-otp/send-verification-otp", "/api/auth/sign-in/email-otp"])
        let body = try XCTUnwrap(AuthHTTPStub.requests[1].bodyData)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: body) as? [String: String])?["otp"], "123456")
        XCTAssertEqual(auth.user?.email, "person@example.com")
    }
    func testRejectedSyncRevalidatesSessionAndUsesRenewedCookie() async throws {
        AuthHTTPStub.set([loginReply(), .init(status: 401, body: #"{"error":"Unauthorized"}"#),
                          .init(body: "{\"user\":\(userJSON)}", cookie: "__Secure-better-auth.session_token=renewed; Path=/; HttpOnly; Secure"),
                          .init(body: #"{"foodEntries":[],"recipes":[],"settings":null}"#)])
        try await auth.signIn(email: "person@example.com", password: "test-password")
        let api = APIClient(baseURL: auth.baseURL, session: transport) { [auth] user, refresh in
            try await auth!.cookie(expectedUserID: user, refresh: refresh)
        }
        _ = try await api.bootstrap(userID: "account-a")
        XCTAssertEqual(AuthHTTPStub.requests.map { $0.url?.path }, ["/api/auth/sign-in/email", "/sync/bootstrap", "/api/auth/get-session", "/sync/bootstrap"])
        XCTAssertEqual(AuthHTTPStub.requests.last?.value(forHTTPHeaderField: "Cookie"), "__Secure-better-auth.session_token=renewed")
        XCTAssertTrue(AuthHTTPStub.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil })
    }
    func testExpiredSessionRequiresSignInAndClearsSavedCredential() async throws {
        AuthHTTPStub.set([loginReply(), .init(body: "null")])
        try await auth.signIn(email: "person@example.com", password: "test-password")
        do { _ = try await auth.cookie(expectedUserID: "account-a", refresh: true); XCTFail("Expected sign-in requirement") }
        catch APIError.signedOut { }
        XCTAssertNil(auth.user)
        XCTAssertNil(storage.data)
    }
    func testOfflineRestoreKeepsCachedAccountAndDiaryAvailable() async throws {
        AuthHTTPStub.set([loginReply()])
        try await auth.signIn(email: "person@example.com", password: "test-password")
        AuthHTTPStub.failure = URLError(.notConnectedToInternet)
        let restored = NativeAuth(baseURL: auth.baseURL, session: transport, storage: storage)
        await restored.restore()
        XCTAssertEqual(restored.user?.id, "account-a")
        XCTAssertTrue(restored.isLoaded)
        XCTAssertNotNil(storage.data)
    }
    func testBodyTokenWithoutSessionCookieDoesNotSignIn() async throws {
        AuthHTTPStub.set([.init(body: "{\"user\":\(userJSON),\"token\":\"not-a-signed-cookie\"}")])
        do { try await auth.signIn(email: "person@example.com", password: "test-password"); XCTFail("Missing cookie must fail") }
        catch { XCTAssertTrue(error.localizedDescription.contains("session")) }
        XCTAssertNil(auth.user)
        XCTAssertNil(storage.data)
    }
    func testAccountMismatchCannotAuthenticateAnotherUsersRequests() async throws {
        AuthHTTPStub.set([loginReply()])
        try await auth.signIn(email: "person@example.com", password: "test-password")
        do { _ = try await auth.cookie(expectedUserID: "another-account", refresh: false); XCTFail("Account mismatch") }
        catch APIError.signedOut { }
        XCTAssertEqual(AuthHTTPStub.requests.count, 1)
    }
    func testSignOutClearsLocalCredentialEvenWhenNetworkIsUnavailable() async throws {
        AuthHTTPStub.set([loginReply()])
        try await auth.signIn(email: "person@example.com", password: "test-password")
        AuthHTTPStub.failure = URLError(.notConnectedToInternet)
        try await auth.signOut()
        XCTAssertNil(auth.user)
        XCTAssertNil(storage.data)
    }
}

final class MemoryAuthStorage: AuthCredentialStorage {
    var data: Data?
    func load() throws -> Data? { data }
    func save(_ data: Data) throws { self.data = data }
    func clear() throws { data = nil }
}

private extension URLRequest {
    var bodyData: Data? {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let size = stream.read(&buffer, maxLength: buffer.count)
            if size <= 0 { break }
            result.append(buffer, count: size)
        }
        return result
    }
}

private final class AuthHTTPStub: URLProtocol, @unchecked Sendable {
    struct Reply { var status = 200; var body: String; var cookie: String? }
    private static let lock = NSLock()
    private static var replies: [Reply] = []
    private static var captured: [URLRequest] = []
    static var failure: Error?
    static var requests: [URLRequest] { lock.withLock { captured } }
    static func set(_ values: [Reply]) { lock.withLock { replies = values; captured = []; failure = nil } }
    static func reset() { set([]) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reply: Reply? = Self.lock.withLock {
            Self.captured.append(request)
            return Self.replies.isEmpty ? nil : Self.replies.removeFirst()
        }
        if let failure = Self.failure { client?.urlProtocol(self, didFailWithError: failure); return }
        guard let reply, let url = request.url else { client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return }
        var headers = ["Content-Type": "application/json"]
        if let cookie = reply.cookie { headers["Set-Cookie"] = cookie }
        let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
