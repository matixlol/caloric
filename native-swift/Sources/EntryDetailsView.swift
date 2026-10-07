import SwiftUI

struct EntryDetailsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let entryID: String
    @State private var calories = ""
    @State private var protein = ""
    @State private var carbs = ""
    @State private var fat = ""
    @State private var editingRecipe: RecipeRoute?
    @State private var addingIngredient = false
    private var entry: FoodEntry? { store.entries.first { $0.id == entryID }?.data }
    var body: some View {
        ScrollView {
            if let entry {
                let n = entry.nutrition?.multiplied(by: entry.portion) ?? Nutrition()
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 12) {
                        Text(entry.foodName).font(.system(size: 28, weight: .bold)).frame(maxWidth: .infinity, alignment: .leading)
                        Button { commitQuick(); dismiss() } label: { Image(systemName: "xmark").foregroundStyle(.secondary).frame(width: 32, height: 32).background(Theme.card, in: Circle()) }.accessibilityLabel("Close details")
                    }
                    Text([entry.meal.label, entry.brand, entry.serving].compactMap { $0 }.joined(separator: " • ")).font(.system(size: 14)).foregroundStyle(.secondary)
                    if entry.isQuickAdd {
                        QuickAddFields(calories: $calories, protein: $protein, carbs: $carbs, fat: $fat).caloricCard()
                        if QuickAdd.nutrition(calories: calories, protein: protein, carbs: carbs, fat: fat) == nil { Text("Enter calories from 1 to 10,000 and macros from 0 to 1,000g.").font(.caption).foregroundStyle(.red) }
                    } else {
                    PortionControl(value: Binding(get: { self.entry?.portion ?? 1 }, set: { portion in
                        store.perform { try store.update(id: entryID) { $0.portion = portion } }
                    })).caloricCard(padding: 12)
                    }
                    if !entry.isQuickAdd {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("Calories").font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
                            Spacer()
                            Text("\(Int((n.calories ?? 0).rounded()).formatted()) kcal").font(.system(size: 22, weight: .bold)).monospacedDigit()
                        }
                        HStack(spacing: 10) {
                            legend("Protein", Theme.protein); legend("Carbs", Theme.carbs); legend("Fat", Theme.fat)
                        }
                        GeometryReader { geometry in
                            let values = [n.protein ?? 0, n.carbs ?? 0, n.fat ?? 0]
                            let calories = [values[0] * 4, values[1] * 4, values[2] * 9]
                            let shares = Self.macroShares(calories)
                            HStack(spacing: 0) {
                                segment(values[0], calories[0], Theme.protein, .white).frame(width: geometry.size.width * shares[0])
                                segment(values[1], calories[1], Theme.carbs, Color(red: 31 / 255, green: 41 / 255, blue: 55 / 255)).frame(width: geometry.size.width * shares[1])
                                segment(values[2], calories[2], Theme.fat, .white).frame(width: geometry.size.width * shares[2])
                            }.clipShape(RoundedRectangle(cornerRadius: 10))
                        }.frame(height: 76)
                    }.caloricCard(padding: 12)
                    if n.hasCalorieMismatch { CalorieMismatchBadge() }
                    }
                    if let items = entry.recipeItems {
                        HStack {
                            Text("Ingredients").font(.headline)
                            Spacer()
                            if let recipeID = entry.recipeId, store.recipes.contains(where: { $0.id == recipeID }) { Button("Edit recipe") { editingRecipe = RecipeRoute(id: recipeID) } }
                        }.padding(.top, 8)
                        VStack(spacing: 0) {
                            if items.isEmpty { Text("No ingredients yet.").foregroundStyle(.secondary).padding(.vertical, 12) }
                            ForEach(items, id: \.id) { item in
                                IngredientRow(item: item, change: { portion in changeIngredient(item.id, portion: portion) }, remove: { changeIngredient(item.id, portion: nil) })
                                if item.id != items.last?.id { Divider() }
                            }
                        }.caloricCard()
                        Button { addingIngredient = true } label: { Label("Add to this entry", systemImage: "plus").frame(maxWidth: .infinity).padding(14) }.background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                    }
                    if let error = store.error { Text(error).font(.caption).foregroundStyle(.red) }
                    PrimaryButton(title: "Done", enabled: !entry.isQuickAdd || QuickAdd.nutrition(calories: calories, protein: protein, carbs: carbs, fat: fat) != nil) { commitQuick(); dismiss() }
                }.padding(16)
            } else {
                ContentUnavailableView("Entry not found", systemImage: "fork.knife", description: Text("This log entry was removed or is unavailable."))
                Button("Done") { dismiss() }
            }
        }.background(Theme.background).scrollDismissesKeyboard(.interactively)
            .onAppear {
                calories = entry?.nutrition?.calories.map { String(Int($0.rounded())) } ?? ""
                protein = entry?.nutrition?.protein.map { String($0) } ?? ""
                carbs = entry?.nutrition?.carbs.map { String($0) } ?? ""
                fat = entry?.nutrition?.fat.map { String($0) } ?? ""
            }
            .task(id: [calories, protein, carbs, fat]) {
                guard entry?.isQuickAdd == true else { return }
                do { try await Task.sleep(for: .milliseconds(200)); commitQuick() } catch { }
            }
            .sheet(item: $editingRecipe) { RecipeEditorView(recipeID: $0.id) }
            .sheet(isPresented: $addingIngredient) { if let entry { FoodSearchView(meal: entry.meal, day: entry.dateKey, recipeEntryID: entryID) } }
    }
    private func commitQuick() {
        guard entry?.isQuickAdd == true, let nutrition = QuickAdd.nutrition(calories: calories, protein: protein, carbs: carbs, fat: fat) else { return }
        store.perform { try store.update(id: entryID) { $0.nutrition = nutrition } }
    }
    private func changeIngredient(_ id: String, portion: Double?) {
        guard var items = entry?.recipeItems else { return }
        if let portion { if let i = items.firstIndex(where: { $0.id == id }) { items[i].portion = portion } }
        else { items.removeAll { $0.id == id } }
        store.perform { try store.updateLoggedRecipe(id: entryID, items: items) }
    }
    private func legend(_ label: String, _ color: Color) -> some View {
        HStack(spacing: 6) { Circle().fill(color).frame(width: 8, height: 8); Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary) }
    }
    private func segment(_ gramsValue: Double, _ calories: Double, _ color: Color, _ text: Color) -> some View {
        VStack(spacing: 4) {
            Text(grams(gramsValue)).font(.system(size: 22, weight: .bold))
            Text("\(Int(calories.rounded()).formatted()) kcal").font(.system(size: 12, weight: .medium)).opacity(0.85)
        }.monospacedDigit().foregroundStyle(text).frame(maxWidth: .infinity).frame(height: 76).background(color).minimumScaleFactor(0.6)
    }
    static func macroShares(_ values: [Double]) -> [Double] {
        let positive = values.map { max(0, $0) }, total = values.reduce(0) { $0 + max(0, $1) }
        guard total > 0 else { return values.map { _ in 1 / Double(values.count) } }
        let base = positive.map { $0 / total }
        let small = base.indices.filter { base[$0] < 0.2 }, large = base.indices.filter { base[$0] >= 0.2 }
        let deficit = small.reduce(0) { $0 + 0.2 - base[$1] }, available = large.reduce(0) { $0 + base[$1] }
        guard !small.isEmpty, available > deficit else { return base }
        return base.indices.map { small.contains($0) ? 0.2 : base[$0] - deficit * base[$0] / available }
    }
}
