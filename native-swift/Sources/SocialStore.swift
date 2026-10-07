import Foundation
import Observation

struct SocialProfile: Codable, Identifiable, Equatable {
    var userId: String
    var displayName: String
    var friendCode: String?
    var since: Int64?
    var id: String { userId }
}
struct FriendRequest: Codable, Identifiable, Equatable { var id: String; var createdAt: Int64; var requester: SocialProfile?; var recipient: SocialProfile? }
struct SocialOverview: Codable, Equatable { var profile: SocialProfile; var friends: [SocialProfile]; var incomingRequests: [FriendRequest]; var outgoingRequests: [FriendRequest] }
struct FriendSummary: Codable, Identifiable, Equatable {
    var userId: String
    var displayName: String
    var dateKey: String
    var calories: Double
    var protein: Double
    var carbs: Double
    var fat: Double
    var calorieGoal: Int?
    var lastUpdatedAt: Int64?
    var id: String { userId }
}
struct FriendSummaries: Decodable { var summaries: [FriendSummary] }
struct FriendFood: Decodable, Identifiable {
    var id: String
    var data: FoodEntry
    var updatedAt: Int64
    enum CodingKeys: String, CodingKey { case id, updatedAt }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id); updatedAt = try values.decode(Int64.self, forKey: .updatedAt)
        data = try FoodEntry(from: decoder)
    }
    var record: FoodRecord { FoodRecord(id: id, data: data, updatedAt: updatedAt) }
}
struct FriendDay: Decodable { var summary: FriendSummary; var entries: [FriendFood]; var settings: UserSettings? }

@MainActor @Observable
final class SocialStore {
    private(set) var overview: SocialOverview?
    private(set) var summaries: [FriendSummary] = []
    private(set) var loading = false
    private(set) var loadingDaily = false
    private(set) var pending = false
    private(set) var error: String?
    private(set) var dailyError: String?
    private(set) var userID: String?
    private(set) var day = ""
    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private var dailyGeneration = UUID()
    init(api: APIClient? = nil) { self.api = api ?? APIClient() }
    func activate(userID: String?) {
        guard self.userID != userID else { return }
        self.userID = userID; overview = nil; summaries = []; error = nil; dailyError = nil; day = ""
        loading = false; loadingDaily = false; pending = false; dailyGeneration = UUID()
    }
    func loadOverview() async {
        guard let userID else { return }
        loading = true
        defer { if self.userID == userID { loading = false } }
        if AppConfiguration.uiTesting {
            overview = SocialOverview(profile: SocialProfile(userId: userID, displayName: "Preview", friendCode: "SWIFT123"), friends: [], incomingRequests: [], outgoingRequests: [])
            return
        }
        do {
            let result: SocialOverview = try await api.authenticated("social/me", userID: userID)
            guard self.userID == userID, !Task.isCancelled else { return }
            overview = result; error = nil
        } catch { if self.userID == userID, !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func loadDaily(_ day: String) async {
        guard let userID else { return }
        let generation = UUID(); dailyGeneration = generation
        if self.day != day { summaries = [] }; self.day = day
        loadingDaily = true; dailyError = nil
        defer { if dailyGeneration == generation { loadingDaily = false } }
        if AppConfiguration.uiTesting { return }
        do {
            let result: FriendSummaries = try await api.authenticated("social/daily-summaries", userID: userID, query: [URLQueryItem(name: "dateKey", value: day)])
            guard self.userID == userID, dailyGeneration == generation, !Task.isCancelled else { return }
            summaries = result.summaries
        } catch { if self.userID == userID, dailyGeneration == generation, !Task.isCancelled { dailyError = error.localizedDescription } }
    }
    func mutate(_ path: String, values: [String: String] = [:], method: String = "POST") async {
        guard let userID, !pending else { return }
        pending = true; error = nil
        defer { if self.userID == userID { pending = false } }
        do {
            let result: SocialOverview = try await api.authenticated("social/\(path)", userID: userID, method: method, body: method == "DELETE" ? nil : JSONEncoder().encode(values))
            guard self.userID == userID, !Task.isCancelled else { return }
            overview = result
            if !day.isEmpty { await loadDaily(day) }
        } catch { if self.userID == userID, !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func friendDay(userID: String, dateKey: String) async throws -> FriendDay {
        guard let owner = self.userID else { throw APIError.signedOut }
        let result: FriendDay = try await api.authenticated("social/friends/\(userID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? userID)/day", userID: owner, query: [URLQueryItem(name: "dateKey", value: dateKey)])
        guard self.userID == owner else { throw APIError.signedOut }
        return result
    }
}
