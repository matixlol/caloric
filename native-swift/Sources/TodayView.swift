import SwiftUI

private enum DiarySheet: Identifiable {
    case food(Meal, String), entry(String), settings, friend(FriendRoute)
    var id: String {
        switch self { case let .food(meal, day): "food-\(meal.rawValue)-\(day)"; case let .entry(id): id; case .settings: "settings"; case let .friend(route): "friend-\(route.id)" }
    }
}

struct TodayView: View {
    @Environment(AppStore.self) private var store
    @Environment(SocialStore.self) private var social
    @State private var dayOffset = 0
    @State private var currentDate = Date()
    @Environment(\.scenePhase) private var scenePhase
    @State private var sheet: DiarySheet?
    @State private var layout = DiaryLayout()
    @State private var drag: DiaryDragSession?
    @State private var lastDragEndedAt = -Double.infinity
    @State private var visible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var selectedDate: Date { Calendar.current.date(byAdding: .day, value: dayOffset, to: currentDate) ?? currentDate }
    private var day: String { LocalDay.key(selectedDate) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                      VStack(alignment: .leading, spacing: 1) {
                        Text(dayOffset == 0 ? "Today" : dayOffset == -1 ? "Yesterday" : selectedDate.formatted(.dateTime.month(.abbreviated).day())).screenTitle()
                        Text(selectedDate.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                      }.padding(.top, 4).accessibilityIdentifier("diary-heading")
                      Button { sheet = .settings } label: { Image(systemName: "gearshape").font(.system(size: 20)).foregroundStyle(.secondary).frame(width: 44, height: 44) }.accessibilityLabel("Settings")
                    }
                    if dayOffset != 0 {
                        Button("Back to today") { withAnimation { dayOffset = 0 } }
                            .font(.system(size: 13, weight: .semibold)).padding(.horizontal, 12).padding(.vertical, 6)
                            .background(Theme.card, in: Capsule())
                    }
                    NutritionSummary(nutrition: Nutrition.total(store.entries(on: day)), settings: store.settings)
                }.contentShape(Rectangle()).gesture(daySwipe)
                FriendsCard(day: day) { friend in sheet = .friend(FriendRoute(id: friend.userId, day: day, name: friend.displayName)) }
                ForEach(Meal.allCases) { meal in
                    MealSection(meal: meal, entries: displayedEntries(in: meal), day: day,
                                draggedID: drag?.row.id, targeted: drag?.meal == meal,
                                minimumHeight: drag?.row.data.meal == meal && drag?.meal != meal ? drag?.sourceMealHeight ?? 0 : 0,
                                add: { sheet = .food(meal, day) }, edit: openEntry)
                }
                if let error = store.error { Text(error).font(.caption).foregroundStyle(.secondary) }
                if let error = store.syncError { Text(error).font(.caption).foregroundStyle(.secondary) }
            }.padding(.horizontal, 16).padding(.bottom, 100)
        }.background(Theme.background).scrollIndicators(.hidden)
            .refreshable { await store.synchronize(); await social.loadDaily(day) }
            .onPreferenceChange(DiaryLayoutKey.self) { layout = $0 }
            .background(DiaryDragGesture(enabled: visible && sheet == nil, rowFrames: layout.rows,
                                         began: beginDrag, moved: moveDrag, ended: endDrag))
            .overlay {
                GeometryReader { geometry in
                    if let drag {
                        FoodRowContent(row: drag.row).frame(width: drag.size.width, height: drag.size.height)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .shadow(color: .black.opacity(0.2), radius: 12, y: 6)
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.tint.opacity(0.25), lineWidth: 1))
                            .scaleEffect(reduceMotion ? 1 : 1.025)
                            .position(x: drag.point.x - drag.grab.x + drag.size.width / 2 - geometry.frame(in: .global).minX,
                                      y: drag.point.y - drag.grab.y + drag.size.height / 2 - geometry.frame(in: .global).minY)
                            .accessibilityHidden(true)
                    }
                }.allowsHitTesting(false)
            }
            .onAppear { visible = true }
            .onDisappear { visible = false; drag = nil }
            .onChange(of: day) { _, _ in drag = nil }
            .task(id: day) { await social.loadDaily(day) }
            .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in currentDate = Date(); store.updateWidget() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { currentDate = Date() } }
            .accessibilityAction(named: "Previous day") { dayOffset -= 1 }
            .accessibilityAction(named: "Next day") { dayOffset = min(0, dayOffset + 1) }
            .sheet(item: $sheet) { route in
                switch route {
                case let .food(meal, day): FoodSearchView(meal: meal, day: day)
                case let .entry(id): EntryDetailsView(entryID: id)
                case .settings: SettingsView().presentationDragIndicator(.visible)
                case let .friend(route): FriendDayView(route: route)
                }
            }
            .overlay { AILogView(isPresented: sheet == nil).opacity(sheet == nil ? 1 : 0).allowsHitTesting(sheet == nil) }
    }

    private func displayedEntries(in meal: Meal) -> [FoodRecord] {
        let entries = store.entries(on: day, meal: meal)
        guard let drag else { return entries }
        var rows = entries.filter { $0.id != drag.row.id }
        if drag.meal == meal {
            let index = drag.beforeID.flatMap { id in rows.firstIndex { $0.id == id } } ?? rows.count
            rows.insert(drag.row, at: index)
        }
        return rows
    }
    private func openEntry(id: String) {
        // A hosting button can deliver its release after the window's drag ends.
        guard drag == nil, ProcessInfo.processInfo.systemUptime - lastDragEndedAt > 0.35 else { return }
        sheet = .entry(id)
    }
    private func beginDrag(id: String, point: CGPoint) {
        guard let row = store.entries.first(where: { $0.id == id && $0.data.dateKey == day }),
              let frame = layout.rows[id] else { return }
        let entries = store.entries(on: day, meal: row.data.meal)
        let index = entries.firstIndex { $0.id == id } ?? 0
        let next = index + 1 < entries.count ? entries[index + 1].id : nil
        drag = DiaryDragSession(row: row, meal: row.data.meal, beforeID: next, point: point,
                                grab: CGPoint(x: point.x - frame.minX, y: point.y - frame.minY), size: frame.size,
                                sourceMealHeight: layout.meals[row.data.meal]?.height ?? 0)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
    private func moveDrag(point: CGPoint) {
        guard var session = drag else { return }
        session.point = point
        let meal = Meal.allCases.min { a, b in
            distance(point.y, to: layout.meals[a]) < distance(point.y, to: layout.meals[b])
        } ?? session.meal
        let rows = displayedEntries(in: meal).filter { $0.id != session.row.id }
        let before = rows.first { (layout.rows[$0.id]?.midY ?? .greatestFiniteMagnitude) > point.y }?.id
        if meal != session.meal || before != session.beforeID {
            session.meal = meal; session.beforeID = before
            withAnimation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.86)) { drag = session }
            UISelectionFeedbackGenerator().selectionChanged()
        } else {
            var transaction = Transaction(); transaction.disablesAnimations = true
            withTransaction(transaction) { drag = session }
        }
    }
    private func distance(_ y: CGFloat, to frame: CGRect?) -> CGFloat {
        guard let frame else { return .greatestFiniteMagnitude }
        return max(frame.minY - y, y - frame.maxY, 0)
    }
    private func endDrag(cancelled: Bool) {
        guard let session = drag else { return }
        lastDragEndedAt = ProcessInfo.processInfo.systemUptime
        withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.86)) {
            if !cancelled { store.perform { try store.move(id: session.row.id, to: session.meal, day: day, before: session.beforeID) } }
            drag = nil
        }
        if !cancelled { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    }
    private var daySwipe: some Gesture {
        DragGesture(minimumDistance: 30).onEnded { value in
            guard abs(value.translation.width) > abs(value.translation.height), abs(value.translation.width) > 60 else { return }
            withAnimation(.easeInOut(duration: 0.2)) { dayOffset = value.translation.width > 0 ? dayOffset - 1 : min(0, dayOffset + 1) }
        }
    }
}

private struct DiaryDragSession {
    let row: FoodRecord
    var meal: Meal
    var beforeID: String?
    var point: CGPoint
    let grab: CGPoint
    let size: CGSize
    let sourceMealHeight: CGFloat
}

struct NutritionSummary: View {
    let nutrition: Nutrition
    let settings: UserSettings
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Calories").font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(Int((nutrition.calories ?? 0).rounded()).formatted()).font(.system(size: 46, weight: .bold))
                Text("/ \(settings.calorieGoal.formatted())").font(.system(size: 22, weight: .medium)).foregroundStyle(.secondary)
            }.monospacedDigit().padding(.top, 8)
            ProgressTrack(value: nutrition.calories ?? 0, goal: Double(settings.calorieGoal), height: 6).padding(.top, 12)
            Divider().padding(.vertical, 14)
            HStack(spacing: 12) {
                macro("Protein", nutrition.protein ?? 0, settings.proteinGoal, Theme.protein)
                Divider()
                macro("Carbs", nutrition.carbs ?? 0, settings.carbsGoal, Theme.carbs)
                Divider()
                macro("Fat", nutrition.fat ?? 0, settings.fatGoal, Theme.fat)
            }.fixedSize(horizontal: false, vertical: true)
        }.caloricCard(padding: 14).padding(.top, 0)
    }
    private func macro(_ name: String, _ value: Double, _ goal: Int, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(name).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
            (Text(Int(value.rounded()).formatted()).font(.system(size: 16, weight: .bold)) + Text(" / \(goal)").font(.system(size: 14, weight: .medium)).foregroundColor(.secondary))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.75)
            ProgressTrack(value: value, goal: Double(goal), color: color)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MealSection: View {
    @Environment(AppStore.self) private var store
    let meal: Meal
    let entries: [FoodRecord]
    let day: String
    let draggedID: String?
    let targeted: Bool
    let minimumHeight: CGFloat
    let add: () -> Void
    let edit: (String) -> Void
    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: 14).overlay {
                Text(meal.label.uppercased()).font(.system(size: 10, weight: .bold)).tracking(1.6)
                    .foregroundStyle(.secondary).fixedSize().rotationEffect(.degrees(-90))
            }.accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(Int((Nutrition.total(entries).calories ?? 0).rounded()).formatted()).font(.system(size: 28, weight: .bold))
                        Text("KCAL").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    }.monospacedDigit()
                    Spacer()
                    MacroBadges(nutrition: Nutrition(protein: Nutrition.total(entries).protein, carbs: Nutrition.total(entries).carbs, fat: Nutrition.total(entries).fat))
                    Button(action: add) { Text("+").font(.system(size: 22, weight: .semibold)).frame(width: 32, height: 32).background(Theme.background, in: Circle()) }
                        .buttonStyle(.plain).foregroundStyle(Theme.tint).accessibilityLabel("Add food to \(meal.label)")
                }.padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 8)
                if entries.isEmpty {
                    Text(meal.emptyCopy).font(.system(size: 14)).foregroundStyle(.secondary)
                        .padding(.horizontal, 12).padding(.vertical, 18)
                } else {
                    ForEach(entries) { row in
                        SwipeFoodRow(row: row, identifier: "diary-row-\(meal.rawValue)-\(row.data.foodName)", isReordering: draggedID != nil, edit: { edit(row.id) }, delete: { store.perform { try store.delete(id: row.id) } })
                            .opacity(row.id == draggedID ? 0 : 1)
                            .background {
                                if row.id == draggedID { RoundedRectangle(cornerRadius: 8).fill(Theme.tint.opacity(0.08)).padding(.horizontal, 6).padding(.vertical, 3) }
                            }
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: DiaryLayoutKey.self, value: DiaryLayout(rows: [row.id: geometry.frame(in: .global)]))
                            })
                            .accessibilityHidden(row.id == draggedID)
                            .accessibilityAction(named: "Delete") { store.perform { try store.delete(id: row.id) } }
                            .accessibilityActions {
                                ForEach(Meal.allCases.filter { $0 != meal }) { destination in
                                    Button("Move to \(destination.label)") { store.perform { try store.move(id: row.id, to: destination, day: day) } }
                                }
                            }
                        if row.id != entries.last?.id { Divider().padding(.horizontal, 12) }
                    }
                }
            }.frame(minHeight: minimumHeight, alignment: .top)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 14)).clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(targeted ? Theme.tint.opacity(0.4) : .clear, lineWidth: 2))
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: DiaryLayoutKey.self, value: DiaryLayout(meals: [meal: geometry.frame(in: .global)]))
                })
        }
    }
}

private struct SwipeFoodRow: View {
    let row: FoodRecord
    let identifier: String
    let isReordering: Bool
    let edit: () -> Void
    let delete: () -> Void
    @State private var offset: CGFloat = 0
    @State private var horizontal = false
    @State private var lastSwipeEndedAt = -Double.infinity
    var body: some View {
        ZStack(alignment: .trailing) {
            Button(action: delete) { Image(systemName: "trash").foregroundStyle(.white).frame(width: 64).frame(maxHeight: .infinity).contentShape(Rectangle()) }
                .buttonStyle(.plain).background(.red).accessibilityLabel("Delete \(row.data.foodName)")
                .opacity(offset < 0 ? 1 : 0).allowsHitTesting(offset < 0 && !isReordering).accessibilityHidden(offset >= 0)
                .zIndex(1)
            Button {
                guard !isReordering, !horizontal,
                      ProcessInfo.processInfo.systemUptime - lastSwipeEndedAt > 0.35 else { return }
                if offset < 0 { withAnimation { offset = 0 } } else { edit() }
            } label: { FoodRowContent(row: row).background(Theme.card) }
                .buttonStyle(.plain).accessibilityLabel("Edit \(row.data.foodName)").accessibilityIdentifier(identifier).offset(x: offset)
                .simultaneousGesture(DragGesture(minimumDistance: 20, coordinateSpace: .global).onChanged { value in
                    guard !isReordering else { return }
                    guard abs(value.translation.width) > abs(value.translation.height) else { return }
                    horizontal = true
                    offset = max(-64, min(0, value.translation.width))
                }.onEnded { value in
                    if horizontal {
                        lastSwipeEndedAt = ProcessInfo.processInfo.systemUptime
                        if !isReordering { withAnimation(.easeOut(duration: 0.18)) { offset = value.translation.width < -30 ? -64 : 0 } }
                    }
                    horizontal = false
                })
        }.clipped().onChange(of: isReordering) { _, active in if active { offset = 0; horizontal = false } }
    }
}

private struct FoodRowContent: View {
    let row: FoodRecord
    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.data.foodName).font(.system(size: 16)).foregroundStyle(.primary)
                Text(row.data.meta).font(.system(size: 12)).foregroundStyle(.secondary)
                if row.data.nutrition?.hasCalorieMismatch == true { CalorieMismatchBadge() }
            }
            Spacer(minLength: 4)
            Text(Int(((row.data.nutrition?.calories ?? 0) * row.data.portion).rounded()).formatted())
                .font(.system(size: 16, weight: .medium)).monospacedDigit().foregroundStyle(.primary)
        }.padding(.horizontal, 12).padding(.vertical, 10).frame(minHeight: 52).contentShape(Rectangle())
    }
}
