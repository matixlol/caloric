import SwiftUI

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(NativeAuth.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @State private var goal = "2500"
    @State private var ratios = UserSettings()
    @State private var confirmSignOut = false
    @State private var signingOut = false
    @State private var error: String?
    @State private var labs = AssistantLabs.shared
    @State private var versionTaps = 0
    @State private var labsUnlocked = false
    private var edited: UserSettings {
        var settings = ratios
        settings.calorieGoal = Int(goal) ?? 0
        return settings
    }
    var body: some View {
      NavigationStack {
        Form {
            Section {
                HStack {
                    Text("Daily Calories")
                    Spacer()
                    TextField("2500", text: $goal).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                        .monospacedDigit().foregroundStyle(.secondary).frame(maxWidth: 120).accessibilityLabel("Daily calorie goal")
                }
            } header: { Text("Goals") } footer: {
                if !edited.isValid { Text("Daily calorie goal must be between 100 and 10000.").foregroundStyle(.red) }
            }
            Section {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 10) {
                        legend("Protein \(edited.proteinGoal)g", Theme.protein)
                        Spacer(minLength: 0)
                        legend("Carbs \(edited.carbsGoal)g", Theme.carbs)
                        Spacer(minLength: 0)
                        legend("Fat \(edited.fatGoal)g", Theme.fat)
                    }.minimumScaleFactor(0.75).lineLimit(1)
                    MacroRatioSlider(settings: $ratios).frame(height: 52)
                }.padding(.vertical, 6)
            } header: { Text("Macro Ratios") } footer: { Text("Drag the handles to split your daily calories between protein, carbs and fat.") }
            FriendsSettingsView()
            Section {
                LabeledContent("Signed in as") {
                    Text(AppConfiguration.uiTesting ? "preview@caloric.app" : auth.user?.email ?? "").lineLimit(1).truncationMode(.middle)
                }
                LabeledContent("Cloud Sync") {
                    HStack(spacing: 6) {
                        Circle().fill(syncColor).frame(width: 8, height: 8)
                        Text(syncLabel)
                    }.accessibilityElement(children: .combine).accessibilityIdentifier("sync-status")
                }
                LabeledContent("Last Synced") {
                    if let date = store.lastSyncedAt { Text(date, style: .relative) } else { Text("Never") }
                }
                Button { Task { await store.synchronize() } } label: {
                    HStack {
                        Label("Sync Now", systemImage: "arrow.triangle.2.circlepath")
                        Spacer()
                        if store.isSyncing { ProgressView() }
                    }
                }.formAction().disabled(store.isSyncing)
                Button(role: .destructive) { confirmSignOut = true } label: {
                    Text(signingOut ? "Signing Out..." : "Sign Out")
                }.formAction(.red).disabled(signingOut)
            } header: { Text("Account") } footer: {
                if let message = error ?? store.syncError ?? store.error { Text(message).foregroundStyle(error != nil || store.syncError != nil ? .red : .secondary) }
            }
            if labsUnlocked || labs.override != nil { labsSection }
            Section {} footer: {
                Text(versionText).font(.caption2).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity).contentShape(Rectangle())
                    .onTapGesture {
                        versionTaps += 1
                        if versionTaps >= 7 && !labsUnlocked {
                            withAnimation { labsUnlocked = true }
                            UINotificationFeedbackGenerator().notificationOccurred(.success)
                        }
                    }
                    .accessibilityIdentifier("settings-version")
            }
        }
            .formStyle(.grouped).tint(Theme.tint).scrollDismissesKeyboard(.interactively)
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
    private var versionText: String {
        let info = Bundle.main.infoDictionary
        return "caloric \(info?["CFBundleShortVersionString"] as? String ?? "") (\(info?["CFBundleVersion"] as? String ?? ""))"
    }
    private var labsSection: some View {
        Section {
            Picker("Assistant", selection: Binding(get: { labs.override }, set: { labs.override = $0 })) {
                Text("Default").tag(AssistantVariant?.none)
                Text("Classic").tag(AssistantVariant?.some(.classic))
                Text("Next (new model + photos)").tag(AssistantVariant?.some(.next))
            }.pickerStyle(.menu).accessibilityIdentifier("labs-assistant-picker")
        } header: { Text("Labs") } footer: {
            Text("Default follows your account (\(labs.serverVariant == .next ? "Next" : "Classic")). Changing this starts a new chat.")
        }.accessibilityIdentifier("labs-section")
    }
    private var syncColor: Color { store.isSyncing ? Theme.tint : store.syncError != nil ? .red : store.dirty || store.lastSyncedAt == nil ? Theme.carbs : .green }
    private func load() { goal = "\(store.settings.calorieGoal)"; ratios = store.settings }
    private var syncLabel: String { store.isSyncing ? "Syncing" : store.syncError != nil ? "Sync Failed" : store.dirty ? "Pending" : store.lastSyncedAt != nil ? "Synced" : "Not Synced" }
    private func legend(_ text: String, _ color: Color) -> some View {
        HStack(spacing: 5) { Circle().fill(color).frame(width: 8, height: 8); Text(text).font(.footnote.weight(.semibold)).monospacedDigit().foregroundStyle(.secondary) }
    }
}

private struct FormAction: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    let color: Color
    func body(content: Content) -> some View { content.foregroundStyle(isEnabled ? color : Color(uiColor: .tertiaryLabel)) }
}

extension View {
    /// The root view forces a label-colored foreground, so Form buttons need their tint applied explicitly.
    func formAction(_ color: Color = Theme.tint) -> some View { modifier(FormAction(color: color)) }
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
                    section(settings.macroCarbsPct, Theme.carbs, BrandPalette.ink).frame(width: geometry.size.width * Double(settings.macroCarbsPct) / 100)
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
