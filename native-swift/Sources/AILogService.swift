import Foundation
import Observation

struct ApprovalOutput: Codable, Equatable { var approved: Bool; var reason: String? }
struct FoodSuggestion: Codable, Identifiable, Equatable {
    var suggestionId: String
    var resultId: String
    var meal: Meal
    var portion: Double
    var reason: String
    var food: SearchFood
    var output: ApprovalOutput?
    var id: String { suggestionId }
}
struct AgentEvent: Decodable {
    var kind: String
    var text: String?
    var query: String?
    var foods: [SearchFood]?
    var toolCallId: String?
    var suggestions: [FoodSuggestion]?
}
struct StreamPayload: Decodable {
    var type: String
    var status: String?
    var event: AgentEvent?
    var resolvedUserMessage: String?
    var error: String?
    var message: String?
    var turnId: String?
    var seq: Int?
}
struct ChatMessage: Identifiable {
    var id = UUID().uuidString
    var kind: String
    var role = "assistant"
    var text = ""
    var query: String?
    var foods: [SearchFood] = []
    var toolCallID: String?
    var suggestions: [FoodSuggestion] = []
    var duration: String?
    /// Photos attached to a user message (next assistant only).
    var images: [AssistantImage] = []
}

/// Handles multiline SSE data, CRLF, and the final frame without a trailing blank line.
struct SSEDecoder {
    private var lines: [String] = []
    mutating func append(_ line: String) -> Data? {
        if line.isEmpty { return flush() }
        if line.hasPrefix("data:") {
            var value = String(line.dropFirst(5))
            if value.hasPrefix(" ") { value.removeFirst() }
            lines.append(value)
        }
        return nil
    }
    mutating func flush() -> Data? {
        guard !lines.isEmpty else { return nil }
        let value = lines.joined(separator: "\n")
        lines.removeAll()
        return Data(value.utf8)
    }
}

/// AsyncBytes.lines omits blank lines. Parse bytes so SSE frame separators survive.
struct SSEByteDecoder {
    private var line: [UInt8] = []
    private var previousCR = false
    private var frames = SSEDecoder()
    mutating func append(_ byte: UInt8) -> Data? {
        if byte == 10 && previousCR { previousCR = false; return nil }
        previousCR = byte == 13
        if byte == 10 || byte == 13 {
            let text = String(decoding: line, as: UTF8.self); line.removeAll(keepingCapacity: true)
            return frames.append(text)
        }
        line.append(byte); return nil
    }
    mutating func flush() -> Data? {
        if !line.isEmpty { _ = frames.append(String(decoding: line, as: UTF8.self)); line.removeAll() }
        return frames.flush()
    }
}

@MainActor @Observable
final class AILogService {
    var messages: [ChatMessage] = []
    private(set) var streaming = false
    var error: String?
    private var sessionID: String?
    private var accountID: String?
    private(set) var activeTurnID: String?
    private(set) var appliedSequence = -1
    private var activeAssistantID: String?
    private var activeUserMessageID: String?
    private var terminal = false
    private var foreground = true
    /// The assistant experience this conversation belongs to. Switching it starts a new chat.
    private(set) var variant: AssistantVariant = .classic
    /// Variant sent with `ai/session`; nil omits the field (classic default behaviour).
    private var requestedVariant: AssistantVariant?
    /// Variant reported by the server for the current session, when it says so.
    private(set) var sessionVariant: AssistantVariant?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var timeoutTask: Task<Void, Never>?
    @ObservationIgnored private var operationID: UUID?
    @ObservationIgnored private let requestTimeout: Duration
    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let session: URLSession
    init(api: APIClient? = nil, session: URLSession? = nil, requestTimeout: Duration = .seconds(210)) {
        self.api = api ?? APIClient(); self.session = session ?? NativeAuth.makeSession(); self.requestTimeout = requestTimeout
    }

    // URLSession's idle timeout can be kept alive by SSE heartbeats. Bound the
    // whole operation as well, including authentication, session creation and resume.
    private func beginOperation() -> UUID {
        let id = UUID()
        operationID = id
        timeoutTask?.cancel()
        timeoutTask = Task { [weak self, requestTimeout] in
            do { try await Task.sleep(for: requestTimeout) } catch { return }
            guard let self, operationID == id else { return }
            operationID = nil
            task?.cancel(); task = nil; timeoutTask = nil
            activeTurnID = nil; streaming = false
            error = "The AI response took too long. Please try again."
        }
        return id
    }

    private func finishOperation(_ id: UUID) {
        guard operationID == id else { return }
        timeoutTask?.cancel(); timeoutTask = nil; operationID = nil
        streaming = activeTurnID != nil; task = nil
        if Task.isCancelled, foreground, activeTurnID != nil { setForeground(true) }
    }

    func reset(accountID: String?) {
        guard self.accountID != accountID else { return }
        self.accountID = accountID
        startNewConversation()
    }
    /// Cancels any running request and forgets the server session and visible conversation.
    func startNewConversation() {
        operationID = nil; timeoutTask?.cancel(); timeoutTask = nil
        task?.cancel(); task = nil; sessionID = nil; sessionVariant = nil; messages = []; streaming = false; error = nil
        activeTurnID = nil; appliedSequence = -1; activeAssistantID = nil; activeUserMessageID = nil; terminal = false
    }
    /// Selects the assistant experience. The chat restarts only when the effective variant changes;
    /// `requested` is what the next `ai/session` request sends.
    func configure(variant: AssistantVariant, requested: AssistantVariant?) {
        requestedVariant = requested
        guard variant != self.variant else { return }
        self.variant = variant
        startNewConversation()
    }
    struct SessionContext: Encodable {
        var recentLogs: [Hint]
        var variant: AssistantVariant?
        struct Hint: Encodable { var foodName: String; var meal: Meal; var brand: String?; var serving: String?; var createdAt: Int64; var dateKey: String }
    }
    struct MultipartImage { var data: Data; var filename: String }
    /// Builds the `ai/turn` multipart body. Audio-only bodies are identical to the original classic encoding.
    static func multipartBody(boundary: String, sessionID: String, text: String, audio: Data?, images: [Data]) -> Data {
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        func file(_ name: String, filename: String, type: String, _ data: Data) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(type)\r\n\r\n".utf8))
            body.append(data); body.append(Data("\r\n".utf8))
        }
        field("sessionId", sessionID); field("actionType", "user-message")
        if !text.isEmpty { field("message", text) }
        if let audio { file("audio", filename: "voice.m4a", type: "audio/m4a", audio) }
        for (index, image) in images.enumerated() { file("image", filename: "photo-\(index + 1).jpg", type: "image/jpeg", image) }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }
    func submit(_ text: String, store: AppStore, audio: URL? = nil, duration: String? = nil, images: [AssistantImage] = []) {
        guard !streaming, accountID != nil else { return }
        var message = ChatMessage(kind: audio == nil ? "text" : "audio", role: "user", text: audio == nil ? text : "Voice message", duration: duration)
        message.images = images
        messages.append(message); streaming = true; error = nil
        activeTurnID = nil; appliedSequence = -1; activeAssistantID = nil; activeUserMessageID = message.id; terminal = false
        let activeAccount = accountID
        let operation = beginOperation()
        task = Task {
            defer {
                finishOperation(operation)
                if let audio { try? FileManager.default.removeItem(at: audio) }
            }
            do {
                if sessionID == nil {
                    struct Session: Decodable { var sessionId: String; var variant: String? }
                    let cutoff = LocalDay.milliseconds() - 3 * 24 * 60 * 60 * 1000
                    let hints = store.entries.filter { $0.data.createdAt >= cutoff }.prefix(80).map {
                        SessionContext.Hint(foodName: $0.data.foodName, meal: $0.data.meal, brand: $0.data.brand, serving: $0.data.serving, createdAt: $0.data.createdAt, dateKey: $0.data.dateKey)
                    }
                    let context = SessionContext(recentLogs: hints, variant: requestedVariant)
                    let request = try await api.request("ai/session", method: "POST", body: JSONEncoder().encode(context), expectedUserID: activeAccount)
                    let response: Session = try await api.send(request)
                    try Task.checkCancellation()
                    guard accountID == activeAccount, operationID == operation else { return }
                    sessionID = response.sessionId
                    sessionVariant = response.variant.flatMap(AssistantVariant.init(rawValue:))
                }
                guard let sessionID else { return }
                if !images.isEmpty, sessionVariant == .classic {
                    throw APIError.response(400, "Photos are not available for this chat yet. Start a new chat and try again.")
                }
                var request: URLRequest
                if audio != nil || !images.isEmpty {
                    let boundary = "Caloric-\(UUID().uuidString)"
                    let body = Self.multipartBody(boundary: boundary, sessionID: sessionID, text: text,
                                                  audio: try audio.map { try Data(contentsOf: $0) }, images: images.map(\.jpeg))
                    request = try await api.request("ai/turn", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)", expectedUserID: activeAccount)
                } else {
                    struct Turn: Encodable { var sessionId: String; var action: Action; struct Action: Encodable { var type = "user-message"; var message: String } }
                    request = try await api.request("ai/turn", method: "POST", body: JSONEncoder().encode(Turn(sessionId: sessionID, action: .init(message: text))), expectedUserID: activeAccount)
                }
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                try await consumeWithResume(original: request, userMessageID: message.id, account: activeAccount, operation: operation)
            } catch is CancellationError { }
            catch {
                if !Task.isCancelled, accountID == activeAccount, operationID == operation { activeTurnID = nil; self.error = "Could not complete the AI request. \(error.localizedDescription)" }
            }
        }
    }
    func process(_ frame: Data, userMessageID: String) throws {
        if String(data: frame, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) == "[DONE]" { terminal = true; activeTurnID = nil; return }
        let payload = try JSONDecoder().decode(StreamPayload.self, from: frame)
        if let seq = payload.seq, seq <= appliedSequence { return }
        switch payload.type {
        case "turn": activeTurnID = payload.turnId
        case "status": if payload.status == "ready" { terminal = true; activeTurnID = nil }
        case "done": terminal = true; activeTurnID = nil
        case "event": if let event = payload.event { apply(event) }
        case "resolved-user-message":
            if let text = payload.resolvedUserMessage, let i = messages.firstIndex(where: { $0.id == userMessageID }) {
                messages[i].text = text
            }
        case "error": throw APIError.response(500, payload.message ?? payload.error ?? "AI request failed")
        default: break
        }
        if let seq = payload.seq { appliedSequence = seq }
        if payload.type == "event", payload.seq != nil, payload.event?.kind == "assistant" { activeAssistantID = nil }
    }
    private func apply(_ event: AgentEvent) {
        switch event.kind {
        case "assistant-delta":
            guard let text = event.text, !text.isEmpty else { return }
            if let i = messages.firstIndex(where: { $0.id == activeAssistantID }) { messages[i].text += text }
            else { let message = ChatMessage(kind: "text", text: text); activeAssistantID = message.id; messages.append(message) }
        case "assistant":
            guard let text = event.text, !text.isEmpty else { return }
            if let i = messages.firstIndex(where: { $0.id == activeAssistantID }) { messages[i].text = text }
            else { let message = ChatMessage(kind: "text", text: text); activeAssistantID = message.id; messages.append(message) }
        case "search": activeAssistantID = nil; messages.append(ChatMessage(kind: "search", query: event.query, foods: event.foods ?? []))
        case "approval":
            activeAssistantID = nil
            messages.append(ChatMessage(kind: "approval", toolCallID: event.toolCallId, suggestions: event.suggestions ?? []))
        default: break
        }
    }
    private func consumeWithResume(original: URLRequest?, userMessageID: String, account: String?, operation: UUID) async throws {
        var lastError: Error = URLError(.networkConnectionLost)
        for attempt in 0...3 {
            try Task.checkCancellation()
            guard accountID == account, operationID == operation else { return }
            if attempt > 0 { try await Task.sleep(for: .milliseconds(500 * attempt)) }
            do {
                let request: URLRequest
                if let turn = activeTurnID {
                    var resumed = try await api.request("ai/turn/\(turn)/stream", expectedUserID: account)
                    var url = URLComponents(url: resumed.url!, resolvingAgainstBaseURL: false)!
                    url.queryItems = [URLQueryItem(name: "cursor", value: String(appliedSequence))]
                    resumed.url = url.url; resumed.setValue("text/event-stream", forHTTPHeaderField: "Accept"); request = resumed
                } else if let original, attempt == 0 { request = original }
                else { throw lastError }
                var (bytes, response) = try await session.bytes(for: request)
                if (response as? HTTPURLResponse)?.statusCode == 401 {
                    bytes.task.cancel()
                    (bytes, response) = try await session.bytes(for: api.reauthenticate(request, userID: account))
                }
                defer { bytes.task.cancel() }
                if (response as? HTTPURLResponse)?.statusCode == 404 { sessionID = nil }
                try APIClient.validate(response)
                var decoder = SSEByteDecoder()
                for try await byte in bytes {
                    try Task.checkCancellation(); guard accountID == account, operationID == operation else { return }
                    if let frame = decoder.append(byte) {
                        try process(frame, userMessageID: userMessageID)
                        // Completion is an SSE event, not transport EOF. A proxy
                        // can leave the body open after the server finishes.
                        if terminal { return }
                    }
                }
                if let frame = decoder.flush() { try process(frame, userMessageID: userMessageID) }
                if terminal { return }
                lastError = URLError(.networkConnectionLost)
            } catch is CancellationError { throw CancellationError() }
            catch {
                // URLSession may report task cancellation as URLError.cancelled.
                // Preserve the detached turn when the app backgrounds.
                try Task.checkCancellation()
                lastError = error; if terminal || (error as? APIError) != nil { throw error }
            }
            guard activeTurnID != nil else { throw lastError }
            if !foreground { return }
        }
        throw lastError
    }
    func setForeground(_ active: Bool) {
        foreground = active
        if !active { task?.cancel(); return }
        guard activeTurnID != nil, task == nil, let userMessageID = activeUserMessageID else { return }
        let account = accountID
        let operation = beginOperation()
        task = Task {
            defer {
                finishOperation(operation)
            }
            do { try await consumeWithResume(original: nil, userMessageID: userMessageID, account: account, operation: operation) }
            catch is CancellationError { }
            catch { if !Task.isCancelled, accountID == account, operationID == operation { activeTurnID = nil; self.error = "Could not restore the AI response. \(error.localizedDescription)" } }
        }
    }
    /// Logs or rejects a suggestion. `portion` and `meal` let the user adjust it before adding.
    @discardableResult
    func approve(messageID: String, suggestionID: String, approved: Bool, store: AppStore, portion: Double? = nil, meal: Meal? = nil) -> Bool {
        guard !streaming, let m = messages.firstIndex(where: { $0.id == messageID }),
              let s = messages[m].suggestions.firstIndex(where: { $0.id == suggestionID }), messages[m].suggestions[s].output == nil else { return false }
        var suggestion = messages[m].suggestions[s]
        if approved {
            if let portion { suggestion.portion = Portion.sanitize(portion) }
            if let meal { suggestion.meal = meal }
        }
        do {
            if approved { try store.add(food: suggestion.food, meal: suggestion.meal, portion: suggestion.portion) }
            suggestion.output = ApprovalOutput(approved: approved, reason: approved ? nil : "User rejected this suggestion.")
            messages[m].suggestions[s] = suggestion
            return true
        } catch { self.error = "Could not save the food. \(error.localizedDescription)"; return false }
    }
    #if DEBUG
    /// UI-test fixture hook: show a conversation as if a turn were still streaming.
    func simulateStreaming(_ messages: [ChatMessage]) { self.messages = messages; streaming = true }
    #endif
    /// A short description of what the assistant is doing for the latest user message.
    var activity: String? { Self.activity(messages: messages, streaming: streaming, writingID: activeAssistantID) }
    static func activity(messages: [ChatMessage], streaming: Bool, writingID: String? = nil) -> String? {
        guard streaming, let user = messages.lastIndex(where: { $0.role == "user" }) else { return streaming ? "Thinking…" : nil }
        let replies = messages[(user + 1)...]
        guard let last = replies.last else {
            let message = messages[user]
            if message.kind == "audio" { return "Listening to your note…" }
            if !message.images.isEmpty { return message.images.count == 1 ? "Looking at your photo…" : "Looking at your photos…" }
            return "Thinking…"
        }
        switch last.kind {
        case "search": return "Searching for “\(last.query ?? last.foods.first?.name ?? "foods")”…"
        case "text": return last.role == "assistant" && last.id == writingID ? nil : "Thinking…"
        default: return "Thinking…"
        }
    }
}
