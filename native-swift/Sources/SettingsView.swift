import SwiftUI

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(NativeAuth.self) private var auth
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @State private var goal = "2500"
    @State private var ratios = UserSettings()
    @State private var confirmSignOut = false
    @State private var signingOut = false
    @State private var error: String?
    private var edited: UserSettings {
        var settings = ratios
        settings.calorieGoal = Int(goal) ?? 0
        return settings
    }
    var body: some View {
      NavigationStack {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: 8) {
                    Text("Cloud sync").font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                    HStack(spacing: 4) {
                        Circle().fill(syncColor).frame(width: 6, height: 6)
                        Text(store.isSyncing ? "Syncing" : store.syncError != nil ? "Sync failed" : store.dirty ? "Pending" : store.lastSyncedAt != nil ? "Synced" : "Not synced").fontWeight(.semibold)
                    }.font(.system(size: 10)).lineLimit(1).fixedSize().padding(.horizontal, 8).padding(.vertical, 6)
                        .background(syncColor.opacity(0.08), in: Capsule()).accessibilityIdentifier("sync-status")
                }.padding(.top, 4)
                sectionTitle("Goals")
                HStack {
                    Text("Daily Calories").font(.system(size: 16))
                    Spacer()
                    TextField("2500", text: $goal).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                        .font(.system(size: 16)).frame(width: 85).accessibilityLabel("Daily calorie goal")
                }.padding(.vertical, 3).caloricCard()
                if !edited.isValid { Text("Daily calorie goal must be between 100 and 10000.").font(.system(size: 13)).foregroundStyle(.red) }
                sectionTitle("Macro Ratios")
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 10) {
                        legend("Protein \(edited.proteinGoal)g", Theme.protein)
                        legend("Carbs \(edited.carbsGoal)g", Theme.carbs)
                        legend("Fat \(edited.fatGoal)g", Theme.fat)
                    }.minimumScaleFactor(0.75).lineLimit(1)
                    MacroRatioSlider(settings: $ratios).frame(height: 52)
                }.caloricCard()
                sectionTitle("Account")
                VStack(spacing: 0) {
                    valueRow("Signed in as", AppConfiguration.uiTesting ? "preview@caloric.app" : auth.user?.email ?? "")
                    Divider()
                    HStack { Text("Last synced"); Spacer(); if let date = store.lastSyncedAt { Text(date, style: .relative).foregroundStyle(.secondary) } else { Text("Never").foregroundStyle(.secondary) } }.font(.system(size: 14)).padding(.vertical, 12)
                    Divider()
                    Button { Task { await store.synchronize() } } label: {
                        HStack { Text("Sync now"); Spacer(); if store.isSyncing { ProgressView() } else { Image(systemName: "arrow.triangle.2.circlepath") } }
                    }.font(.system(size: 16)).foregroundStyle(Theme.tint).padding(.vertical, 14).disabled(store.isSyncing)
                    Divider()
                    Button(signingOut ? "Signing Out..." : "Sign Out") { confirmSignOut = true }
                        .font(.system(size: 16)).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 14).disabled(signingOut)
                }.caloricCard(padding: 14)
                if let error { Text(error).font(.system(size: 13)).foregroundStyle(.red) }
                if let error = store.error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
                if let error = store.syncError { Text(error).font(.system(size: 13)).foregroundStyle(.red) }
                sectionTitle("Friends")
                FriendsSettingsView()
                sectionTitle("Updates")
                VStack(spacing: 0) {
                    valueRow("Status", "Updates through TestFlight"); Divider()
                    valueRow("Last checked", "Managed by TestFlight"); Divider()
                    valueRow("Current update", "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"))"); Divider()
                    Button("Force Check") { openURL(URL(string: "itms-beta://")!) }
                        .font(.system(size: 16)).foregroundStyle(Theme.tint).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 14)
                }.caloricCard(padding: 14)
            }.padding(.horizontal, 16).padding(.bottom, 24)
        }.background(Theme.background).scrollDismissesKeyboard(.interactively)
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.large)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityLabel("Close Settings") } }
            .onAppear { load() }
            .onChange(of: store.settings) { previous, _ in if edited == previous { load() } }
            .task(id: edited) {
                guard edited.isValid, edited != store.settings else { return }
                do { try await Task.sleep(for: .milliseconds(200)); try store.saveSettings(edited) }
                catch is CancellationError { }
                catch { self.error = error.localizedDescription }
            }
            .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) {
                    signingOut = true
                    Task {
                        defer { signingOut = false }
                        do { try await auth.signOut() }
                        catch { self.error = "Could not sign out. Try again." }
                    }
                }
            } message: { Text("You will need to sign in again to access your account.") }
      }
    }
    private var syncColor: Color { store.isSyncing ? Theme.tint : store.syncError != nil ? .red : store.dirty || store.lastSyncedAt == nil ? Theme.carbs : .green }
    private func load() { goal = "\(store.settings.calorieGoal)"; ratios = store.settings }
    private func sectionTitle(_ text: String) -> some View { Text(text).font(.system(size: 13)).foregroundStyle(.secondary).padding(.horizontal, 4).padding(.top, 6) }
    private func valueRow(_ label: String, _ value: String) -> some View {
        HStack(spacing: 12) { Text(label).foregroundStyle(.primary); Spacer(minLength: 4); Text(value).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.7) }
            .font(.system(size: 16)).padding(.vertical, 13)
    }
    private func legend(_ text: String, _ color: Color) -> some View {
        HStack(spacing: 5) { Circle().fill(color).frame(width: 8, height: 8); Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary) }
    }
}

struct MacroRatioSlider: View {
    @Binding var settings: UserSettings
    @State private var dragStart: Int?
    var body: some View {
        GeometryReader { geometry in
            let first = settings.macroProteinPct, second = first + settings.macroCarbsPct
            ZStack(alignment: .leading) {
                HStack(spacing: 0) {
                    section(first, Theme.protein, .white).frame(width: geometry.size.width * Double(first) / 100)
                    section(settings.macroCarbsPct, Theme.carbs, Color(red: 31 / 255, green: 41 / 255, blue: 55 / 255)).frame(width: geometry.size.width * Double(settings.macroCarbsPct) / 100)
                    section(settings.macroFatPct, Theme.fat, .white).frame(width: geometry.size.width * Double(settings.macroFatPct) / 100)
                }.clipShape(RoundedRectangle(cornerRadius: 10))
                ForEach(1..<10, id: \.self) { tick in
                    Rectangle().fill(.white.opacity(0.18)).frame(width: 1, height: 52).offset(x: geometry.size.width * Double(tick) / 10)
                }
                handle(first: true, split: first, width: geometry.size.width)
                handle(first: false, split: second, width: geometry.size.width)
            }.coordinateSpace(name: "macro-ratio")
        }
    }
    private func section(_ value: Int, _ color: Color, _ text: Color) -> some View {
        Text("\(value)%").font(.system(size: 16, weight: .bold)).foregroundStyle(text).lineLimit(1).minimumScaleFactor(0.5)
            .frame(maxWidth: .infinity).frame(height: 52).background(color).clipped()
    }
    private func handle(first: Bool, split: Int, width: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 7).fill(.white).frame(width: 24, height: 44)
            .overlay(Capsule().fill(Color.gray.opacity(0.6)).frame(width: 3, height: 20))
            .shadow(color: .black.opacity(0.2), radius: 3, y: 1).frame(width: 44, height: 52)
            .offset(x: width * Double(split) / 100 - 22)
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("macro-ratio")).onChanged { value in
                if dragStart == nil { dragStart = split }
                let next = (dragStart ?? split) + Int((value.translation.width / max(1, width) * 100).rounded())
                setSplit(next, first: first)
            }.onEnded { _ in dragStart = nil })
            .accessibilityElement().accessibilityLabel(first ? "Adjust protein and carbs split" : "Adjust carbs and fat split")
            .accessibilityValue("\(split) percent").accessibilityAdjustableAction { direction in
                setSplit(split + (direction == .increment ? 1 : -1), first: first)
            }
    }
    private func setSplit(_ value: Int, first: Bool) {
        let splitB = settings.macroProteinPct + settings.macroCarbsPct
        if first {
            settings.macroProteinPct = max(0, min(splitB, value))
            settings.macroCarbsPct = splitB - settings.macroProteinPct
        } else {
            let next = max(settings.macroProteinPct, min(100, value))
            settings.macroCarbsPct = next - settings.macroProteinPct
            settings.macroFatPct = 100 - next
        }
    }
}
