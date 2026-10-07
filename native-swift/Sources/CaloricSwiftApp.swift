import SwiftUI
import Network

@main
struct CaloricSwiftApp: App {
    @State private var store = AppStore()
    @State private var auth = NativeAuth.shared
    @State private var social = SocialStore()
    var body: some Scene {
        WindowGroup {
            RootView().environment(auth).environment(store).environment(social).tint(Theme.tint)
        }
    }
}

struct RootView: View {
    @Environment(NativeAuth.self) private var auth
    @Environment(AppStore.self) private var store
    @Environment(SocialStore.self) private var social
    @Environment(\.scenePhase) private var scenePhase
    @State private var networkMonitor: NWPathMonitor?
    private var activeID: String? { AppConfiguration.uiTesting ? "ui-test-user" : auth.user?.id }
    var body: some View {
        Group {
            if !AppConfiguration.uiTesting && !auth.isLoaded {
                ProgressView()
            } else if AppConfiguration.uiTesting || auth.user != nil {
                if store.ready {
                    TodayView()
                } else if let error = store.error {
                    ContentUnavailableView { Label("Could not load data", systemImage: "exclamationmark.triangle") } description: { Text(error) } actions: {
                        Button("Retry") { Task { await store.activate(userID: activeID) } }
                    }
                } else { ProgressView() }
            } else {
                SignInView()
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.background)
            .task(id: activeID) {
                social.activate(userID: activeID)
                await store.activate(userID: activeID)
                #if DEBUG
                if AppConfiguration.uiTesting, ProcessInfo.processInfo.arguments.contains("-seed-food"), store.entries.isEmpty {
                    store.perform { try store.add(food: SearchFood(id: "fixture", canonicalKey: "fixture", source: "mfp", sourceLabel: "MFP", name: "Grilled chicken", brand: "Caloric", serving: "100 g", nutrition: Nutrition(calories: 165, protein: 31, carbs: 0, fat: 3.6)), meal: .lunch) }
                    if ProcessInfo.processInfo.arguments.contains("-seed-drag-foods") {
                        store.perform { try store.add(food: SearchFood(id: "rice-fixture", canonicalKey: "rice-fixture", source: "mfp", sourceLabel: "MFP", name: "Rice", nutrition: Nutrition(calories: 130)), meal: .lunch) }
                    }
                    if ProcessInfo.processInfo.arguments.contains("-seed-long-diary") {
                        for index in 1...12 {
                            store.perform { try store.add(food: SearchFood(id: "fixture-\(index)", canonicalKey: "fixture-\(index)", source: "mfp", sourceLabel: "MFP", name: "Dinner food \(index)", nutrition: Nutrition(calories: 100)), meal: .dinner) }
                        }
                    }
                }
                #endif
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await auth.refreshOnResume(); await store.synchronize(); store.updateWidget(); await store.ensureBackup(); await social.loadDaily(social.day.isEmpty ? LocalDay.key() : social.day) } }
            }
            .task {
                if !AppConfiguration.uiTesting { await auth.restore() }
                let monitor = NWPathMonitor()
                networkMonitor = monitor
                monitor.pathUpdateHandler = { path in
                    if path.status == .satisfied { Task { @MainActor in await store.synchronize(); await social.loadDaily(social.day.isEmpty ? LocalDay.key() : social.day) } }
                }
                monitor.start(queue: DispatchQueue(label: "caloric.reachability"))
            }.onDisappear { networkMonitor?.cancel() }
    }
}
