import Foundation
import Observation

/// Which food assistant experience is active. `next` uses the experimental model, photos and the new UI.
enum AssistantVariant: String, Codable, CaseIterable, Identifiable {
    case classic, next
    var id: String { rawValue }
}

/// Hidden "shadow flag" for the next assistant: a local override (Settings › Labs) wins over the
/// server allowlist from `ai/config`; anything unknown or failing resolves to classic.
@MainActor @Observable
final class AssistantLabs {
    static let shared = AssistantLabs()
    static let overrideKey = "caloric.ai.variantOverride"

    /// Local override stored in UserDefaults; nil follows the account default.
    var override: AssistantVariant? {
        didSet { if let override { defaults.set(override.rawValue, forKey: Self.overrideKey) } else { defaults.removeObject(forKey: Self.overrideKey) } }
    }
    private(set) var serverVariant: AssistantVariant?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let launchOverride: AssistantVariant?
    @ObservationIgnored private var loadedAccount: String?
    @ObservationIgnored private var loadingAccount: String?

    init(defaults: UserDefaults = .standard, arguments: [String] = ProcessInfo.processInfo.arguments) {
        self.defaults = defaults
        override = defaults.string(forKey: Self.overrideKey).flatMap(AssistantVariant.init(rawValue:))
        #if DEBUG
        launchOverride = arguments.contains("-ai-variant-next") ? .next : arguments.contains("-ai-variant-classic") ? .classic : nil
        #else
        launchOverride = nil
        #endif
    }

    var effective: AssistantVariant { Self.resolve(override: launchOverride ?? override, server: serverVariant) }
    /// Value for `ai/session`: explicit local choice, else the account default; nil omits the field.
    var sessionVariant: AssistantVariant? { Self.sessionVariant(override: launchOverride ?? override, server: serverVariant) }

    static func resolve(override: AssistantVariant?, server: AssistantVariant?) -> AssistantVariant { override ?? server ?? .classic }
    static func sessionVariant(override: AssistantVariant?, server: AssistantVariant?) -> AssistantVariant? { override ?? server }

    /// Fetches the account default once per signed-in account. Failures resolve to classic and retry later.
    func load(accountID: String?, api: APIClient? = nil, force: Bool = false) async {
        if accountID != loadedAccount && accountID != loadingAccount { serverVariant = nil }
        guard let accountID else { loadedAccount = nil; loadingAccount = nil; return }
        guard force || (loadedAccount != accountID && loadingAccount != accountID) else { return }
        guard api != nil || !AppConfiguration.uiTesting else { return }
        struct Config: Decodable { var variant: String? }
        loadingAccount = accountID
        defer { if loadingAccount == accountID { loadingAccount = nil } }
        do {
            let config: Config = try await (api ?? APIClient()).authenticated("ai/config", userID: accountID)
            guard loadingAccount == accountID else { return }
            serverVariant = config.variant.flatMap(AssistantVariant.init(rawValue:)) ?? .classic
            loadedAccount = accountID
        } catch {
            guard loadingAccount == accountID else { return }
            serverVariant = .classic
        }
    }
}
