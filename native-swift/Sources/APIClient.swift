import Foundation

enum APIError: LocalizedError {
    case signedOut, response(Int, String), invalidResponse(String)
    var errorDescription: String? {
        switch self {
        case .signedOut: "Sign in again to sync your data."
        case let .response(code, message): "\(message) (\(code))"
        case let .invalidResponse(path): "Server data could not be loaded at \(path)."
        }
    }
}

@MainActor
protocol SyncAPI {
    func bootstrap(userID: String) async throws -> BootstrapResponse
    func push(_ payload: PushRequest, userID: String) async throws -> PushResponse
}

@MainActor
final class APIClient: SyncAPI {
    typealias CookieProvider = @MainActor (String?, Bool) async throws -> String
    private let session: URLSession
    private let cookieProvider: CookieProvider
    let baseURL: URL
    init(baseURL: URL = AppConfiguration.backendURL, session: URLSession? = nil, cookieProvider: CookieProvider? = nil) {
        self.baseURL = baseURL; self.session = session ?? NativeAuth.makeSession()
        self.cookieProvider = cookieProvider ?? { try await NativeAuth.shared.cookie(expectedUserID: $0, refresh: $1) }
    }
    func request(_ path: String, method: String = "GET", body: Data? = nil,
                 authenticated: Bool = true, contentType: String = "application/json", expectedUserID: String? = nil,
                 refreshSession: Bool = false) async throws -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 120
        request.httpShouldHandleCookies = false
        request.httpBody = body
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if authenticated {
            let cookie = try await cookieProvider(expectedUserID, refreshSession)
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        return request
    }
    func send<T: Decodable>(_ request: URLRequest, as: T.Type = T.self) async throws -> T {
        let (data, response) = try await session.data(for: request)
        try Self.validate(response, data: data)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch let error as DecodingError {
            let path: [CodingKey]
            switch error {
            case let .keyNotFound(key, context): path = context.codingPath + [key]
            case let .typeMismatch(_, context), let .valueNotFound(_, context), let .dataCorrupted(context): path = context.codingPath
            @unknown default: path = []
            }
            throw APIError.invalidResponse(path.isEmpty ? "response" : path.map(\.stringValue).joined(separator: "."))
        }
    }
    func reauthenticate(_ request: URLRequest, userID: String?) async throws -> URLRequest {
        var refreshed = request
        refreshed.setValue(try await cookieProvider(userID, true), forHTTPHeaderField: "Cookie")
        return refreshed
    }
    private func sync<T: Decodable>(_ path: String, userID: String, body: Data? = nil) async throws -> T {
        let method = body == nil ? "GET" : "POST"
        let original = try await request(path, method: method, body: body, expectedUserID: userID)
        do { return try await send(original) }
        catch APIError.response(401, _) {
            // Revalidate/renew the Better Auth session once, retaining the original account.
            let refreshed = try await request(path, method: method, body: body, expectedUserID: userID, refreshSession: true)
            return try await send(refreshed)
        }
    }
    func bootstrap(userID: String) async throws -> BootstrapResponse { try await sync("sync/bootstrap", userID: userID) }
    func push(_ payload: PushRequest, userID: String) async throws -> PushResponse {
        try await sync("sync/push", userID: userID, body: JSONEncoder().encode(payload))
    }
    func search(_ query: String, provider: String) async throws -> [SearchFood] {
        try await searchPage(query, provider: provider, page: 1).foods
    }
    func searchPage(_ query: String, provider: String, page: Int) async throws -> SearchResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("search"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "query", value: query), URLQueryItem(name: "provider", value: provider), URLQueryItem(name: "maxItems", value: "20"), URLQueryItem(name: "page", value: String(max(1, min(10, page))))]
        var result: SearchResponse = try await send(URLRequest(url: components.url!))
        result.foods = result.foods.filter { $0.nutrition != nil }
        return result
    }
    func barcode(_ code: String) async throws -> [SearchFood] {
        guard let normalized = BarcodeScanner.normalize(code) else { throw APIError.response(400, "Enter an 8, 12, or 13 digit barcode.") }
        do {
            let result: SearchResponse = try await send(URLRequest(url: baseURL.appendingPathComponent("search/barcode/\(normalized)")))
            return result.foods.filter { $0.nutrition != nil }
        } catch APIError.response(404, _) { return [] }
    }
    func authenticated<T: Decodable>(_ path: String, userID: String, method: String = "GET", body: Data? = nil, query: [URLQueryItem] = []) async throws -> T {
        func make(refresh: Bool) async throws -> URLRequest {
            var result = try await request(path, method: method, body: body, expectedUserID: userID, refreshSession: refresh)
            if !query.isEmpty {
                var components = URLComponents(url: result.url!, resolvingAgainstBaseURL: false)!
                components.queryItems = query; result.url = components.url
            }
            return result
        }
        do { return try await send(try await make(refresh: false)) }
        catch APIError.response(401, _) { return try await send(try await make(refresh: true)) }
    }
    func queueANMAT(_ query: String) async {
        struct Queue: Encodable { var query: String; var maxItems = 20 }
        do {
            let req = try await request("search/anmat-live", method: "POST", body: JSONEncoder().encode(Queue(query: query)), authenticated: false)
            _ = try await session.data(for: req)
        } catch { /* Background enrichment is best-effort, as in Expo. */ }
    }
    static func validate(_ response: URLResponse, data: Data = Data()) throws {
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200...299).contains(response.statusCode) else {
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.response(response.statusCode, payload?["message"] as? String ?? payload?["error"] as? String ?? "Request failed")
        }
    }
}
