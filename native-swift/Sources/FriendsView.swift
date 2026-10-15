import SwiftUI

struct FriendRoute: Identifiable { let id: String; let day: String; let name: String }

struct FriendsCard: View {
    @Environment(SocialStore.self) private var social
    let day: String
    let open: (FriendSummary) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text(day == LocalDay.key() ? "Friends Today" : "Friends").font(.headline); Spacer(); if social.loadingDaily && social.summaries.isEmpty { ProgressView().controlSize(.small) } else { Text("\(social.summaries.count)").foregroundStyle(.secondary) } }
            if let error = social.dailyError { Text(error).font(.caption).foregroundStyle(.secondary); Button("Retry") { Task { await social.loadDaily(day) } } }
            else if social.summaries.isEmpty && !social.loadingDaily { Text("Add friends in Settings.").font(.subheadline).foregroundStyle(.secondary) }
            ForEach(social.summaries) { friend in
                Button { open(friend) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack { Text(friend.displayName).font(.system(size: 16, weight: .semibold)).foregroundStyle(.primary); Spacer(); Text("\(Int(friend.calories.rounded()).formatted()) kcal").foregroundStyle(.primary).monospacedDigit() }
                        ProgressTrack(value: friend.calories, goal: Double(friend.calorieGoal ?? 2500))
                        if let updated = friend.lastUpdatedAt { Text("Updated \(Date(timeIntervalSince1970: Double(updated) / 1000).formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(.secondary) }
                        else { Text("No logs yet").font(.caption).foregroundStyle(.secondary) }
                    }.padding(.vertical, 4).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Open \(friend.displayName)'s day")
                if friend.id != social.summaries.last?.id { Divider() }
            }
        }.caloricCard()
    }
}

struct FriendsSettingsView: View {
    @Environment(SocialStore.self) private var social
    @State private var name = ""
    @State private var code = ""
    @State private var remove: SocialProfile?
    var body: some View {
        Section {
            if let profile = social.overview?.profile {
                HStack(spacing: 12) {
                    Text("Name")
                    TextField("Name", text: $name).multilineTextAlignment(.trailing).foregroundStyle(.secondary).textContentType(.name).accessibilityLabel("Friend display name")
                    if name != profile.displayName {
                        Button("Save") { act("profile", ["displayName": name.split(whereSeparator: \.isWhitespace).joined(separator: " ")]) }
                            .fontWeight(.semibold).formAction().disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 80 || social.pending)
                    }
                }
                HStack {
                    Text("Your Code")
                    Spacer()
                    Button { UIPasteboard.general.string = profile.friendCode } label: {
                        HStack(spacing: 6) { Text(profile.friendCode ?? "Unavailable").fontWeight(.semibold).monospaced(); Image(systemName: "doc.on.doc").font(.footnote) }
                    }.formAction().accessibilityLabel("Copy your friend code")
                }
                HStack(spacing: 12) {
                    TextField("Add by friend code", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled().accessibilityLabel("Friend code")
                    Button("Add") { act("friend-requests", ["friendCode": code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()]); code = "" }
                        .fontWeight(.semibold).formAction().disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || social.pending)
                }
                ForEach(social.overview?.incomingRequests ?? []) { request in
                    socialRow(request.requester?.displayName ?? "Friend", "Wants to be friends") {
                        Button("Ignore") { act("friend-requests/ignore", ["requestId": request.id]) }.formAction(.secondary)
                        Button("Accept") { act("friend-requests/accept", ["requestId": request.id]) }.fontWeight(.semibold).formAction()
                    }
                }
                ForEach(social.overview?.friends ?? []) { friend in
                    socialRow(friend.displayName, "Friend") { EmptyView() }
                        .swipeActions { Button("Remove", role: .destructive) { remove = friend } }
                        .contextMenu { Button("Remove Friend", systemImage: "person.badge.minus", role: .destructive) { remove = friend } }
                }
                ForEach(social.overview?.outgoingRequests ?? []) { request in socialRow(request.recipient?.displayName ?? "Friend", "Request pending") { EmptyView() } }
            }
            if social.loading { ProgressView().frame(maxWidth: .infinity) }
            if social.overview == nil || social.error != nil { Button("Refresh") { Task { await social.loadOverview(); name = social.overview?.profile.displayName ?? "" } }.formAction() }
        } header: { Text("Friends") } footer: {
            if let error = social.error { Text(error).foregroundStyle(.red) }
            else if social.overview != nil { Text("Share your code so friends can see your daily calories. Swipe a friend to remove them.") }
        }
            .buttonStyle(.borderless).disabled(social.pending)
            .task { await social.loadOverview(); name = social.overview?.profile.displayName ?? "" }
            .confirmationDialog("Remove friend?", isPresented: Binding(get: { remove != nil }, set: { if !$0 { remove = nil } }), titleVisibility: .visible) {
                if let remove { Button("Remove", role: .destructive) { act("friends/\(remove.userId)", method: "DELETE"); self.remove = nil } }
            } message: { Text("Stop sharing daily calories with \(remove?.displayName ?? "this friend")?") }
    }
    private func act(_ path: String, _ values: [String: String] = [:], method: String = "POST") { Task { await social.mutate(path, values: values, method: method) } }
    private func socialRow<Actions: View>(_ name: String, _ meta: String, @ViewBuilder actions: () -> Actions) -> some View {
        HStack(spacing: 16) { VStack(alignment: .leading, spacing: 2) { Text(name); Text(meta).font(.footnote).foregroundStyle(.secondary) }; Spacer(); actions() }
    }
}

struct FriendDayView: View {
    @Environment(SocialStore.self) private var social
    @Environment(\.dismiss) private var dismiss
    let route: FriendRoute
    @State private var data: FriendDay?
    @State private var error: String?
    var body: some View {
      NavigationStack {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(route.day).font(.subheadline).foregroundStyle(.secondary)
                if let data {
                    let records = data.entries.map(\.record)
                    NutritionSummary(nutrition: Nutrition.total(records), settings: data.settings ?? UserSettings())
                    ForEach(Meal.allCases) { meal in
                        VStack(alignment: .leading, spacing: 12) {
                            let entries = records.filter { $0.data.meal == meal }
                            HStack { Text(meal.label).font(.headline); Spacer(); Text("\(Int((Nutrition.total(entries).calories ?? 0).rounded())) kcal").foregroundStyle(.secondary) }
                            if entries.isEmpty { Text(meal.emptyCopy).font(.subheadline).foregroundStyle(.secondary) }
                            ForEach(entries) { row in VStack(alignment: .leading, spacing: 4) { Text(row.data.foodName); Text(row.data.meta).font(.caption).foregroundStyle(.secondary); MacroBadges(nutrition: row.data.nutrition, multiplier: row.data.portion) }; if row.id != entries.last?.id { Divider() } }
                        }.caloricCard()
                    }
                } else if let error { Text(error).foregroundStyle(.red); Button("Retry") { Task { await load() } } }
                else { ProgressView().frame(maxWidth: .infinity).padding(32) }
            }.padding(16)
        }.background(Theme.background).scrollBounceBehavior(.basedOnSize)
            .accessibilityIdentifier("friend-diary")
            .navigationTitle(data?.summary.displayName ?? route.name).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityLabel("Close friend's day") } }
            .task { await load() }
      }
    }
    private func load() async {
        do { data = try await social.friendDay(userID: route.id, dateKey: route.day); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
