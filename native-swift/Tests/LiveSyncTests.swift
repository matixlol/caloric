import XCTest
@testable import CaloricSwift

@MainActor
final class LiveSyncTests: XCTestCase {
    private static var auths: [String: NativeAuth] = [:]
    private static var storages: [String: MemoryAuthStorage] = [:]
    private func login(_ path: String) async throws -> NativeAuth {
        if let auth = Self.auths[path] { return auth }
        struct Login: Decodable { var email: String; var password: String }
        let value = try JSONDecoder().decode(Login.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard value.email.hasPrefix("caloric-swift-check-"), value.email.hasSuffix("@verification.invalid") else { throw XCTSkip("Temporary verification accounts only.") }
        let storage = MemoryAuthStorage(), auth = NativeAuth(storage: storage)
        try await auth.signIn(email: value.email, password: value.password)
        Self.storages[path] = storage; Self.auths[path] = auth
        return auth
    }
    func testProductionZSessionAndDiaryDownload() async throws {
        guard let path = ProcessInfo.processInfo.environment["CALORIC_LIVE_AUTH_FILE"] else {
            throw XCTSkip("Enable explicitly with a private verification account credential file.")
        }
        let auth = try await self.login(path)
        let storage = try XCTUnwrap(Self.storages[path])
        let userID = try XCTUnwrap(auth.user?.id)
        let restored = NativeAuth(storage: storage)
        await restored.restore()
        XCTAssertEqual(restored.user?.id, userID)
        let api = APIClient { user, refresh in try await restored.cookie(expectedUserID: user, refresh: refresh) }
        let snapshot = try await api.bootstrap(userID: userID)
        XCTAssertFalse(snapshot.foodEntries.isEmpty, "The configured review account should contain its existing demo diary.")
        XCTAssertTrue(snapshot.foodEntries.allSatisfy { !$0.data.foodName.isEmpty })
        XCTAssertEqual(snapshot.settings?.data.calorieGoal, 2200)
        XCTAssertEqual(snapshot.foodEntries.first?.data.recipeId, "verification-recipe")
        XCTAssertEqual(snapshot.foodEntries.first?.data.recipeItems?.first?.foodName, "Verification ingredient")
        // Exercise the protected POST endpoint without changing any production data.
        let response = try await api.push(PushRequest(foodEntries: [], settings: nil), userID: userID)
        XCTAssertTrue(response.acceptedFoodEntryIds.isEmpty)
        XCTAssertFalse(response.acceptedSettings)
        let oldCookie = try await restored.cookie(expectedUserID: userID, refresh: false)
        try await restored.signOut()
        XCTAssertNil(restored.user)
        var request = URLRequest(url: AppConfiguration.backendURL.appendingPathComponent("api/auth/get-session"))
        request.setValue(oldCookie, forHTTPHeaderField: "Cookie")
        request.httpShouldHandleCookies = false
        let (data, _) = try await NativeAuth.makeSession().data(for: request)
        XCTAssertEqual(String(data: data, encoding: .utf8), "null", "Sign-out must revoke the server session.")
    }
    func testProductionRecipeRoundTripAndSocialContract() async throws {
        guard let path = ProcessInfo.processInfo.environment["CALORIC_LIVE_AUTH_FILE"] else { throw XCTSkip("Explicit production verification account required.") }
        struct Login: Decodable { var email: String; var password: String }
        let login = try JSONDecoder().decode(Login.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard login.email.hasPrefix("caloric-swift-check-"), login.email.hasSuffix("@verification.invalid") else { throw XCTSkip("Mutating verification is restricted to the temporary verification account.") }
        let auth = try await self.login(path)
        let user = try XCTUnwrap(auth.user?.id)
        let api = APIClient { expected, refresh in try await auth.cookie(expectedUserID: expected, refresh: refresh) }
        var recipe = RecipeRecord(id: "recipe_swift_verification_\(UUID().uuidString.lowercased())", data: Recipe(name: "Swift verification", items: [RecipeItem(id: "ingredient", foodName: "Verification ingredient", portion: 2, nutrition: Nutrition(calories: 100, sodiumMg: 40))], createdAt: LocalDay.milliseconds()), updatedAt: LocalDay.milliseconds(), dirty: true)
        do {
            let created = try await api.push(PushRequest(foodEntries: [], settings: nil, recipes: [recipe]), userID: user)
            XCTAssertEqual(created.acceptedRecipeIds, [recipe.id])
            let saved = try await api.bootstrap(userID: user)
            XCTAssertEqual(saved.recipes.first { $0.id == recipe.id }?.data.nutrition.sodiumMg, 80)
            recipe.data.items[0].portion = 3; recipe.updatedAt += 1
            _ = try await api.push(PushRequest(foodEntries: [], settings: nil, recipes: [recipe]), userID: user)
            let updated = try await api.bootstrap(userID: user)
            XCTAssertEqual(updated.recipes.first { $0.id == recipe.id }?.data.nutrition.calories, 300)
            let overview: SocialOverview = try await api.authenticated("social/me", userID: user)
            XCTAssertFalse(overview.profile.friendCode?.isEmpty ?? true)
            XCTAssertTrue(overview.friends.isEmpty)
            let daily: FriendSummaries = try await api.authenticated("social/daily-summaries", userID: user, query: [URLQueryItem(name: "dateKey", value: LocalDay.key())])
            XCTAssertTrue(daily.summaries.isEmpty)
        } catch {
            recipe.updatedAt += 2; recipe.deletedAt = recipe.updatedAt
            _ = try? await api.push(PushRequest(foodEntries: [], settings: nil, recipes: [recipe]), userID: user)
            throw error
        }
        recipe.updatedAt += 2; recipe.deletedAt = recipe.updatedAt
        let removed = try await api.push(PushRequest(foodEntries: [], settings: nil, recipes: [recipe]), userID: user)
        XCTAssertEqual(removed.acceptedRecipeIds, [recipe.id])
        let final = try await api.bootstrap(userID: user); XCTAssertFalse(final.recipes.contains { $0.id == recipe.id })
    }
    func testProductionFriendRequestIgnoreAcceptDayAndRemoval() async throws {
        guard let pathA = ProcessInfo.processInfo.environment["CALORIC_LIVE_AUTH_FILE"], let pathB = ProcessInfo.processInfo.environment["CALORIC_LIVE_SOCIAL_FILE"] else { throw XCTSkip("Two explicit temporary verification accounts required.") }
        let a = try await login(pathA), b = try await login(pathB)
        let idA = try XCTUnwrap(a.user?.id), idB = try XCTUnwrap(b.user?.id)
        let socialA = SocialStore(api: APIClient { user, refresh in try await a.cookie(expectedUserID: user, refresh: refresh) })
        let socialB = SocialStore(api: APIClient { user, refresh in try await b.cookie(expectedUserID: user, refresh: refresh) })
        socialA.activate(userID: idA); socialB.activate(userID: idB)
        await socialA.loadOverview(); await socialB.loadOverview()
        let codeB = try XCTUnwrap(socialB.overview?.profile.friendCode)
        await socialA.mutate("profile", values: ["displayName": "Swift verification A"])
        XCTAssertEqual(socialA.overview?.profile.displayName, "Swift verification A")
        await socialA.mutate("friend-requests", values: ["friendCode": codeB]); XCTAssertNil(socialA.error)
        await socialB.loadOverview(); let ignored = try XCTUnwrap(socialB.overview?.incomingRequests.first?.id)
        await socialB.mutate("friend-requests/ignore", values: ["requestId": ignored]); XCTAssertTrue(socialB.overview?.incomingRequests.isEmpty == true)
        await socialA.mutate("friend-requests", values: ["friendCode": codeB]); await socialB.loadOverview()
        let accepted = try XCTUnwrap(socialB.overview?.incomingRequests.first?.id)
        await socialB.mutate("friend-requests/accept", values: ["requestId": accepted]); XCTAssertNil(socialB.error)
        XCTAssertTrue(socialB.overview?.friends.contains { $0.userId == idA } == true)
        await socialB.loadDaily(LocalDay.key())
        XCTAssertEqual(socialB.summaries.first { $0.userId == idA }?.calories, 300)
        let day = try await socialB.friendDay(userID: idA, dateKey: LocalDay.key())
        XCTAssertEqual(day.entries.first?.data.recipeItems?.first?.foodName, "Verification ingredient")
        XCTAssertEqual(day.settings?.calorieGoal, 2200)
        await socialA.mutate("friends/\(idB)", method: "DELETE"); XCTAssertNil(socialA.error)
        await socialB.loadDaily(LocalDay.key()); XCTAssertTrue(socialB.summaries.isEmpty)
        try await b.signOut()
    }
    func testProductionAIStreamsThroughNativeBetterAuthSession() async throws {
        guard let path = ProcessInfo.processInfo.environment["CALORIC_LIVE_AUTH_FILE"] else { throw XCTSkip("Explicit verification account required.") }
        struct Login: Decodable { var email: String; var password: String }
        let login = try JSONDecoder().decode(Login.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard login.email.hasPrefix("caloric-swift-check-"), login.email.hasSuffix("@verification.invalid") else { throw XCTSkip("Temporary account only.") }
        let auth = try await self.login(path)
        let id = try XCTUnwrap(auth.user?.id)
        let api = APIClient { user, refresh in try await auth.cookie(expectedUserID: user, refresh: refresh) }
        let store = AppStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), syncEnabled: false)
        await store.activate(userID: id)
        let chat = AILogService(api: api); chat.reset(accountID: id)
        chat.submit("Do not search or log any food. Write twelve short sentences about nutrition.", store: store)
        let deadline = Date().addingTimeInterval(90)
        while chat.activeTurnID == nil && chat.streaming && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertNotNil(chat.activeTurnID, "Capture the detached server turn before interrupting the viewer.")
        chat.setForeground(false)
        try await Task.sleep(for: .milliseconds(300))
        chat.setForeground(true)
        while chat.streaming && Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertFalse(chat.streaming, "The production AI turn must reach ready.")
        XCTAssertNil(chat.error)
        XCTAssertTrue(chat.messages.contains { $0.role == "assistant" && $0.kind == "text" && !$0.text.isEmpty })
        XCTAssertTrue(store.entries.isEmpty, "Unapproved responses must never create diary entries.")
        XCTAssertNil(chat.activeTurnID)
        chat.reset(accountID: nil)
    }
}
