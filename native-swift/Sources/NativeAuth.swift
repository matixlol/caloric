import Foundation
import Observation
import Security

struct AuthUser: Codable, Equatable {
    var id: String
    var email: String
    var name: String?
}

struct AuthCookie: Codable, Equatable {
    var name: String
    var value: String
    var expiresAt: Date?
    var header: String { "\(name)=\(value)" }
    static func sessionCookie(from response: HTTPURLResponse) -> AuthCookie? {
        guard let url = response.url else { return nil }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, field in
            if let key = field.key as? String, let value = field.value as? String { result[key] = value }
        }
        return HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
            .first { ["better-auth.session_token", "__Secure-better-auth.session_token"].contains($0.name) }
            .map { AuthCookie(name: $0.name, value: $0.value, expiresAt: $0.expiresDate) }
    }
}

struct AuthCredential: Codable, Equatable {
    var user: AuthUser
    var cookie: AuthCookie
}

protocol AuthCredentialStorage {
    func load() throws -> Data?
    func save(_ data: Data) throws
    func clear() throws
}

struct KeychainAuthStorage: AuthCredentialStorage {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "lol.mati.caloric.swift.better-auth.\(AppConfiguration.backendURL.host ?? "backend")",
         kSecAttrAccount as String: "session"]
    }
    func load() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw AuthStorageError() }
        return result as? Data
    }
    func save(_ data: Data) throws {
        let values: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw AuthStorageError() }
        } else if status != errSecSuccess { throw AuthStorageError() }
    }
    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw AuthStorageError() }
    }
}

private struct AuthStorageError: LocalizedError {
    var errorDescription: String? { "Could not securely save your sign-in. Please try again." }
}

@Observable @MainActor
final class NativeAuth {
    static let shared = NativeAuth()
    private(set) var user: AuthUser?
    private(set) var isLoaded = false
    private(set) var error: String?
    private var credential: AuthCredential?
    private var generation = 0
    private let storage: any AuthCredentialStorage
    private let session: URLSession
    let baseURL: URL

    init(baseURL: URL = AppConfiguration.backendURL, session: URLSession? = nil,
         storage: any AuthCredentialStorage = KeychainAuthStorage()) {
        self.baseURL = baseURL
        self.session = session ?? Self.makeSession()
        self.storage = storage
        do {
            if let data = try storage.load() {
                credential = try JSONDecoder().decode(AuthCredential.self, from: data)
                user = credential?.user
            }
        } catch { self.error = "Could not restore your sign-in. Please sign in again." }
    }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration)
    }

    func restore() async {
        guard !isLoaded else { return }
        defer { isLoaded = true }
        guard let accountID = user?.id else { return }
        do { try await refreshSession(expectedUserID: accountID) }
        catch is URLError { /* Keep the securely cached account available offline. */ }
        catch { self.error = error.localizedDescription }
    }

    func refreshOnResume() async {
        guard isLoaded, let accountID = user?.id else { return }
        do { try await refreshSession(expectedUserID: accountID) }
        catch { /* Sync reports failures; network outages do not sign the user out. */ }
    }

    func cookie(expectedUserID: String?, refresh: Bool) async throws -> String {
        guard let accountID = expectedUserID ?? user?.id, user?.id == accountID else { throw APIError.signedOut }
        if refresh { try await refreshSession(expectedUserID: accountID) }
        guard user?.id == accountID, let credential else { throw APIError.signedOut }
        return credential.cookie.header
    }

    func sendCode(email: String) async throws {
        _ = try await send("email-otp/send-verification-otp", body: ["email": email, "type": "sign-in"])
    }
    func signIn(email: String, code: String) async throws {
        try await authenticate("sign-in/email-otp", body: ["email": email, "otp": code])
    }
    func signIn(email: String, password: String) async throws {
        try await authenticate("sign-in/email", body: ["email": email, "password": password])
    }
    func signUp(email: String, password: String, name: String) async throws {
        try await authenticate("sign-up/email", body: ["email": email, "password": password, "name": name])
    }

    private func authenticate(_ path: String, body: [String: String]) async throws {
        let started = generation
        let (data, response) = try await send(path, body: body)
        guard generation == started else { throw APIError.signedOut }
        struct LoginResponse: Decodable { var user: AuthUser }
        let result = try JSONDecoder().decode(LoginResponse.self, from: data)
        guard let cookie = AuthCookie.sessionCookie(from: response), !cookie.value.isEmpty else {
            throw APIError.response(502, "Sign-in did not return a session. Please try again.")
        }
        try save(AuthCredential(user: result.user, cookie: cookie))
        generation += 1
        error = nil
        isLoaded = true
    }

    func refreshSession(expectedUserID: String) async throws {
        guard user?.id == expectedUserID, let original = credential else { throw APIError.signedOut }
        let started = generation
        let data: Data
        let response: HTTPURLResponse
        do { (data, response) = try await send("get-session?disableCookieCache=true", cookie: original.cookie.header) }
        catch APIError.response(401, _) {
            if generation == started { try clear() }
            throw APIError.signedOut
        }
        guard generation == started, user?.id == expectedUserID else { throw APIError.signedOut }
        struct SessionResponse: Decodable { var user: AuthUser }
        guard let result = try JSONDecoder().decode(SessionResponse?.self, from: data), result.user.id == expectedUserID else {
            try clear()
            throw APIError.signedOut
        }
        let cookie = AuthCookie.sessionCookie(from: response) ?? original.cookie
        try save(AuthCredential(user: result.user, cookie: cookie))
        error = nil
    }

    func signOut() async throws {
        let cookie = credential?.cookie.header
        // Forget locally even when the server cannot be reached; keep the diary on disk.
        try clear()
        if let cookie { _ = try? await send("sign-out", body: [:], cookie: cookie) }
    }

    private func save(_ value: AuthCredential) throws {
        try storage.save(JSONEncoder().encode(value))
        credential = value
        user = value.user
    }
    private func clear() throws {
        try storage.clear()
        generation += 1
        credential = nil
        user = nil
    }

    private func send(_ path: String, body: [String: String]? = nil, cookie: String? = nil) async throws -> (Data, HTTPURLResponse) {
        let pieces = path.split(separator: "?", maxSplits: 1)
        var components = URLComponents(url: baseURL.appendingPathComponent("api/auth").appendingPathComponent(String(pieces[0])), resolvingAgainstBaseURL: false)!
        if pieces.count > 1 { components.percentEncodedQuery = String(pieces[1]) }
        var request = URLRequest(url: components.url!)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.timeoutInterval = 30
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Better Auth validates Origin for cookie-authenticated POSTs, including sign-out.
        var origin = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        origin.path = ""; origin.query = nil; origin.fragment = nil
        request.setValue(origin.string!, forHTTPHeaderField: "Origin")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        let (data, response) = try await session.data(for: request)
        try APIClient.validate(response, data: data)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, response)
    }
}
