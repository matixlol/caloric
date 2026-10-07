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
        VStack(alignment: .leading, spacing: 0) {
            if let profile = social.overview?.profile {
                HStack { Text("Name"); TextField("Name", text: $name).multilineTextAlignment(.trailing).accessibilityLabel("Friend display name"); Button("Save") { act("profile", ["displayName": name.split(whereSeparator: \.isWhitespace).joined(separator: " ")]) }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 80 || name == profile.displayName || social.pending) }.padding(.vertical, 12)
                Divider()
                HStack { Text("Your Code"); Spacer(); Button(profile.friendCode ?? "Unavailable") { UIPasteboard.general.string = profile.friendCode }.fontWeight(.bold).accessibilityLabel("Copy your friend code") }.padding(.vertical, 12)
                Divider()
                HStack { TextField("Friend code", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled().accessibilityLabel("Friend code"); Button("Add") { act("friend-requests", ["friendCode": code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()]); code = "" }.disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || social.pending) }.padding(.vertical, 12)
                ForEach(social.overview?.incomingRequests ?? []) { request in
                    Divider(); socialRow(request.requester?.displayName ?? "Friend", "Request") {
                        Button("Ignore") { act("friend-requests/ignore", ["requestId": request.id]) }
                        Button("Accept") { act("friend-requests/accept", ["requestId": request.id]) }.fontWeight(.semibold)
                    }
                }
                ForEach(social.overview?.friends ?? []) { friend in Divider(); socialRow(friend.displayName, "Friend") { Button("Remove", role: .destructive) { remove = friend } } }
                ForEach(social.overview?.outgoingRequests ?? []) { request in Divider(); socialRow(request.recipient?.displayName ?? "Friend", "Pending") { EmptyView() } }
            }
            if social.loading { ProgressView().frame(maxWidth: .infinity).padding(12) }
            if let error = social.error { Text(error).font(.caption).foregroundStyle(.red).padding(.vertical, 8) }
            if social.overview == nil || social.error != nil { Button("Refresh") { Task { await social.loadOverview(); name = social.overview?.profile.displayName ?? "" } }.frame(maxWidth: .infinity).padding(12) }
        }.caloricCard().disabled(social.pending)
            .task { await social.loadOverview(); name = social.overview?.profile.displayName ?? "" }
            .confirmationDialog("Remove friend?", isPresented: Binding(get: { remove != nil }, set: { if !$0 { remove = nil } }), titleVisibility: .visible) {
                if let remove { Button("Remove", role: .destructive) { act("friends/\(remove.userId)", method: "DELETE"); self.remove = nil } }
            } message: { Text("Stop sharing daily calories with \(remove?.displayName ?? "this friend")?") }
    }
    private func act(_ path: String, _ values: [String: String] = [:], method: String = "POST") { Task { await social.mutate(path, values: values, method: method) } }
    private func socialRow<Actions: View>(_ name: String, _ meta: String, @ViewBuilder actions: () -> Actions) -> some View {
        HStack(spacing: 8) { VStack(alignment: .leading, spacing: 3) { Text(name); Text(meta).font(.caption).foregroundStyle(.secondary) }; Spacer(); actions().font(.subheadline) }.padding(.vertical, 12)
    }
}

struct FriendDayView: View {
    @Environment(SocialStore.self) private var social
    @Environment(\.dismiss) private var dismiss
    let route: FriendRoute
    @State private var data: FriendDay?
    @State private var error: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text(data?.summary.displayName ?? route.name).screenTitle(); Button("Done") { dismiss() } }
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
        }.background(Theme.background).task { await load() }.refreshable { await load() }
    }
    private func load() async {
        do { data = try await social.friendDay(userID: route.id, dateKey: route.day); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
