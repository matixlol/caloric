import SwiftUI

struct RecipeRoute: Identifiable { var id: String }

struct FoodSearchView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let meal: Meal
    let day: String
    var startWithScanner = false
    var recipeID: String? = nil
    var recipeEntryID: String? = nil
    @State private var query = ""
    @State private var bySource: [String: [SearchFood]] = [:]
    @State private var allFoods: [SearchFood] = []
    @State private var page = 1
    @State private var hasMore: [String: Bool] = [:]
    @State private var searchID = UUID()
    @State private var selected: SearchFood?
    @State private var selectedRecipeID: String?
    @State private var selectedPortion = 1.0
    @State private var provider = "all"
    @State private var searching = false
    @State private var loadingMore = false
    @State private var error: String?
    @State private var enrichment: Task<Void, Never>?
    @State private var barcode: String?
    @State private var showScanner = false
    @State private var openedInitialScanner = false
    @State private var editingRecipe: RecipeRoute?
    @State private var quick = false
    @State private var calories = "250"
    @State private var protein = ""
    @State private var carbs = ""
    @State private var fat = ""
    @State private var caloriePick: Double?
    @State private var portionPick: Double?
    private let sourceOrder = ["openfoodfacts", "mfp"]
    private var ingredientMode: Bool { recipeID != nil || recipeEntryID != nil }
    private var hasQuery: Bool { query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 }
    private var selectedRecipe: RecipeRecord? { store.recipes.first { $0.id == selectedRecipeID } }
    private var visible: [SearchFood] { provider == "all" ? allFoods : bySource[provider] ?? [] }
    private var manualNutrition: Nutrition? { QuickAdd.nutrition(calories: calories, protein: protein, carbs: carbs, fat: fat) }
    private var recents: [FoodRecord] {
        var seen = Set<String>()
        let tokens = normalize(query).split(separator: " ")
        return Array(store.entries.filter { row in
            let key = [row.data.foodName, row.data.brand ?? "", row.data.serving ?? ""].map(normalize).joined(separator: "|")
            return !row.data.isQuickAdd && (!hasQuery || tokens.allSatisfy { key.contains($0) }) && seen.insert(key).inserted
        }.prefix(50))
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Foods").screenTitle()
                    NativeIconButton(symbol: "xmark", label: "Close food search") { dismiss() }
                }.padding(.horizontal, 4)
                HStack(spacing: 10) {
                    HStack {
                        TextField("Search foods (example: banana)", text: $query).font(.system(size: 16)).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search).accessibilityIdentifier("food-search")
                        if !query.isEmpty { Button { query = ""; barcode = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.accessibilityLabel("Clear search") }
                    }.padding(12).frame(minHeight: 44).background(Theme.input, in: RoundedRectangle(cornerRadius: 10))
                    NativeIconButton(symbol: "barcode.viewfinder", label: "Scan barcode") { showScanner = true }
                }.caloricCard(padding: 12)
                if !hasQuery && !ingredientMode { recipesSection }
                if !recents.isEmpty || !hasQuery {
                    section("Recents")
                    if recents.isEmpty { Text("No recent items yet.").font(.subheadline).foregroundStyle(.secondary) }
                    else {
                        VStack(spacing: 0) {
                            ForEach(recents) { row in
                                let food = SearchFood(id: "recent-\(row.id)", canonicalKey: row.id, source: "recent", sourceLabel: "", name: row.data.foodName, brand: row.data.brand, serving: row.data.serving, nutrition: row.data.nutrition)
                                FoodSelectionRow(food: food, selected: selected?.id == food.id) { selected = food; selectedRecipeID = nil; selectedPortion = row.data.portion; quick = false }
                                if row.id != recents.last?.id { Divider() }
                            }
                        }.padding(.horizontal, 14).background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                    }
                }
                if hasQuery {
                    if barcode == nil {
                        Picker("Food source", selection: $provider) {
                            Text("All \(allFoods.count)").tag("all")
                            Text("MFP \(bySource["mfp"]?.count ?? 0)").tag("mfp")
                            Text("OFF \(bySource["openfoodfacts"]?.count ?? 0)").tag("openfoodfacts")
                        }.pickerStyle(.segmented).accessibilityLabel("Food source")
                    }
                    if searching { HStack { ProgressView(); Text(barcode == nil ? "Searching…" : "Looking up barcode…").foregroundStyle(.secondary) }.font(.subheadline) }
                    if let error { Text(error).font(.subheadline).foregroundStyle(.red) }
                    if !searching && error == nil && visible.isEmpty { Text(barcode == nil ? "No foods found for \"\(query)\"." : "No MFP food found for this barcode.").font(.subheadline).foregroundStyle(.secondary) }
                    LazyVStack(spacing: 0) {
                        ForEach(visible) { food in
                            FoodSelectionRow(food: food, selected: selected?.id == food.id) { selected = food; selectedRecipeID = nil; selectedPortion = 1; quick = false }
                            if food.id != visible.last?.id { Divider() }
                        }
                    }.padding(.horizontal, 14).background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                    if !searching && barcode == nil && hasMore.values.contains(true) {
                        HStack { Spacer(); if loadingMore { ProgressView() } else { Button("Load more") { Task { await loadMore() } } }; Spacer() }.padding(10).onAppear { Task { await loadMore() } }
                    }
                }
                if selected != nil || selectedRecipe != nil { PortionControl(value: $selectedPortion).caloricCard(padding: 12) }
                if let error = store.error { Text(error).font(.caption).foregroundStyle(.red) }
            }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 24)
        }.background(Theme.background).scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
            .holdFocusOverlay()
            .task(id: query) { await search() }
            .task {
                if startWithScanner && !openedInitialScanner { openedInitialScanner = true; showScanner = true }
            }
            .sheet(isPresented: $showScanner) { BarcodeScanner { value in barcode = value; provider = "all"; query = value } }
            .sheet(item: $editingRecipe) { RecipeEditorView(recipeID: $0.id) }
            .onDisappear { enrichment?.cancel() }
    }
    private var recipesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            section("Recipes")
            VStack(spacing: 0) {
                ForEach(store.recipes) { recipe in
                    HStack {
                        Button { selectedRecipeID = selectedRecipeID == recipe.id ? nil : recipe.id; selected = nil; selectedPortion = 1; quick = false } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) { Text(recipe.data.name).foregroundStyle(.primary).font(.system(size: 17, weight: .semibold)); Text("\(recipe.data.items.count) ingredients").font(.caption).foregroundStyle(.secondary); MacroBadges(nutrition: recipe.data.nutrition) }.frame(maxWidth: .infinity, alignment: .leading)
                                if selectedRecipeID == recipe.id { Image(systemName: "checkmark").foregroundStyle(Theme.tint) }
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        Button { editingRecipe = RecipeRoute(id: recipe.id) } label: { Image(systemName: "pencil").frame(width: 36, height: 44) }.accessibilityLabel("Edit \(recipe.data.name)")
                    }.padding(.vertical, 12)
                    if selectedRecipeID == recipe.id {
                        ForEach(recipe.data.items, id: \.id) { item in VStack(alignment: .leading, spacing: 3) { Text(item.foodName).font(.subheadline); MacroBadges(nutrition: item.nutrition, multiplier: item.portion) }.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 12).padding(.bottom, 10) }
                    }
                    Divider()
                }
                Button { store.perform { editingRecipe = RecipeRoute(id: try store.createRecipe().id) } } label: { Label("New recipe", systemImage: "plus.circle").frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 14) }
            }.padding(.horizontal, 14).background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        }
    }
    private var actionBar: some View {
      LiquidGlassGroup {
        VStack(spacing: 10) {
            if quick { QuickAddFields(calories: $calories, protein: $protein, carbs: $carbs, fat: $fat).caloricCard(padding: 12) }
            HStack(spacing: 10) {
                if quick { PrimaryButton(title: "Add quick", enabled: manualNutrition != nil) { addQuick(manualNutrition) } }
                else { HoldSlideButton(title: ingredientMode ? "Add to recipe" : "Add to \(meal.label)", enabled: selected != nil || selectedRecipe != nil, values: (1...12).map { Double($0) / 4 }, selection: $portionPick, tapped: { add(portion: selectedPortion) }, committed: { add(portion: $0) }) }
                if !ingredientMode { HoldSlideButton(title: "Quick add", enabled: true, secondary: true, values: QuickCalories.values, selection: $caloriePick, tapped: { withAnimation { quick.toggle(); selected = nil; selectedRecipeID = nil } }, committed: { addQuick(Nutrition(calories: $0)) }).frame(width: 108) }
            }
        }.padding(.horizontal, 16).padding(.vertical, 12)
      }
    }
    private func addQuick(_ nutrition: Nutrition?) {
        guard let nutrition else { return }
        do { try store.add(food: SearchFood(id: "quick", canonicalKey: "quick", source: "manual", sourceLabel: "", name: "Quick add", serving: "Manual entry", nutrition: nutrition), meal: meal, day: day); dismiss() }
        catch { self.error = error.localizedDescription }
    }
    private func add(portion: Double) {
        do {
            if let recipe = selectedRecipe { try store.logRecipe(recipe, meal: meal, day: day, portion: portion) }
            else if let selected {
                if ingredientMode {
                    let item = RecipeItem(id: UUID().uuidString.lowercased(), foodName: selected.name, brand: selected.brand, serving: selected.serving, portion: Portion.sanitize(portion), nutrition: selected.nutrition)
                    if let recipeID { guard store.recipes.contains(where: { $0.id == recipeID }) else { throw APIError.response(404, "Recipe was removed.") }; try store.updateRecipe(id: recipeID) { $0.items.append(item) } }
                    else if let recipeEntryID { guard let entry = store.entries.first(where: { $0.id == recipeEntryID }), let items = entry.data.recipeItems else { throw APIError.response(404, "Entry was removed.") }; try store.updateLoggedRecipe(id: recipeEntryID, items: items + [item]) }
                } else { try store.add(food: selected, meal: meal, day: day, portion: portion) }
            } else { return }
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
    private func section(_ text: String) -> some View { Text(text).font(.system(size: 15)).foregroundStyle(.secondary).padding(.horizontal, 4) }
    private func normalize(_ value: String) -> String { value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).trimmingCharacters(in: .whitespacesAndNewlines) }
    private func search() async {
        let identifier = UUID(); searchID = identifier
        bySource = [:]; allFoods = []; page = 1; hasMore = [:]; searching = false; loadingMore = false; error = nil
        if selected?.source != "recent" { selected = nil }
        guard hasQuery else { return }
        if barcode != nil && barcode != query { barcode = nil }
        do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
        guard !Task.isCancelled else { return }
        searching = true
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines), api = APIClient()
        if let barcode {
            do { let foods = try await api.barcode(barcode); guard searchID == identifier, !Task.isCancelled else { return }; bySource = ["mfp": foods]; allFoods = foods; if foods.count == 1 { selected = foods[0]; selectedPortion = 1 } }
            catch { if searchID == identifier { self.error = error.localizedDescription } }
            if searchID == identifier { searching = false }; return
        }
        enrichment?.cancel(); enrichment = Task { await api.queueANMAT(value) }
        await loadPage(1, sources: sourceOrder, identifier: identifier, query: value)
        if searchID == identifier { searching = false }
    }
    private func loadMore() async {
        guard !searching, !loadingMore, barcode == nil, page < 10 else { return }
        let sources = sourceOrder.filter { hasMore[$0] == true }; guard !sources.isEmpty else { return }
        let identifier = searchID; loadingMore = true
        await loadPage(page + 1, sources: sources, identifier: identifier, query: query.trimmingCharacters(in: .whitespacesAndNewlines))
        if searchID == identifier { loadingMore = false }
    }
    private func loadPage(_ requestedPage: Int, sources: [String], identifier: UUID, query: String) async {
        var incoming: [String: [SearchFood]] = [:]
        let api = APIClient()
        await withTaskGroup(of: (String, SearchResponse?).self) { group in
            for source in sources { group.addTask { (source, try? await api.searchPage(query, provider: source, page: requestedPage)) } }
            for await (source, result) in group {
                guard searchID == identifier, !Task.isCancelled else { group.cancelAll(); return }
                guard let result else { hasMore[source] = false; continue }
                incoming[source] = result.foods; hasMore[source] = result.hasMore == true && requestedPage < 10
                var seen = Set((bySource[source] ?? []).map(\.canonicalKey)); bySource[source, default: []].append(contentsOf: result.foods.filter { seen.insert($0.canonicalKey).inserted })
                if requestedPage == 1 { allFoods = Self.interleave(sourceOrder.map { bySource[$0] ?? [] }) }
            }
        }
        guard searchID == identifier, !Task.isCancelled else { return }
        page = requestedPage
        if requestedPage > 1 { var seen = Set(allFoods.map(\.canonicalKey)); allFoods.append(contentsOf: Self.interleave(sourceOrder.map { incoming[$0] ?? [] }).filter { seen.insert($0.canonicalKey).inserted }) }
        if incoming.isEmpty { error = "Unable to search foods right now. Try again." }
    }
    static func interleave(_ sources: [[SearchFood]]) -> [SearchFood] {
        var result: [SearchFood] = [], seen = Set<String>(), cursors = sources.map { _ in 0 }, advanced = true
        while advanced {
            advanced = false
            for index in sources.indices { while cursors[index] < sources[index].count { let food = sources[index][cursors[index]]; cursors[index] += 1; if seen.insert(food.canonicalKey).inserted { result.append(food); advanced = true; break } } }
        }
        return result
    }
}

struct FoodSelectionRow: View {
    let food: SearchFood
    var selected = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(food.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(.primary)
                    HStack(spacing: 6) { if let brand = food.brand { Text(brand) }; if !food.sourceLabel.isEmpty { Text(food.sourceLabel).font(.system(size: 10, weight: .bold)) }; if let serving = food.serving { Text(serving) } }.font(.system(size: 12)).foregroundStyle(.secondary)
                    MacroBadges(nutrition: food.nutrition)
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark").font(.system(size: 18, weight: .bold)).foregroundStyle(Theme.tint) }
            }.padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel("\(food.name), \(food.meta)").accessibilityAddTraits(selected ? .isSelected : [])
    }
}
