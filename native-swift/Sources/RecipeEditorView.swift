import SwiftUI

struct RecipeEditorView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var recipeID: String
    @State private var name = ""
    @State private var adding = false
    @State private var deleting = false
    private var recipe: RecipeRecord? { store.recipes.first { $0.id == recipeID } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text("Recipe").screenTitle(); Button("Done") { commitName(); dismiss() } }
                if let recipe {
                    TextField("Recipe name", text: $name).font(.title2.bold()).padding(14).background(Theme.card, in: RoundedRectangle(cornerRadius: 14)).accessibilityIdentifier("recipe-name").onSubmit(commitName)
                    VStack(alignment: .leading, spacing: 8) { Text("\(recipe.data.items.count) ingredients").foregroundStyle(.secondary); MacroBadges(nutrition: recipe.data.nutrition) }.caloricCard()
                    Text("Ingredients").font(.subheadline).foregroundStyle(.secondary)
                    VStack(spacing: 0) {
                        if recipe.data.items.isEmpty { Text("No ingredients yet.").foregroundStyle(.secondary).padding(.vertical, 12) }
                        ForEach(recipe.data.items, id: \.id) { item in
                            IngredientRow(item: item, change: { portion in store.perform { try store.updateRecipe(id: recipeID) { recipe in if let i = recipe.items.firstIndex(where: { $0.id == item.id }) { recipe.items[i].portion = portion } } } }, remove: { store.perform { try store.updateRecipe(id: recipeID) { $0.items.removeAll { $0.id == item.id } } } })
                            if item.id != recipe.data.items.last?.id { Divider() }
                        }
                    }.caloricCard()
                    Button { commitName(); adding = true } label: { Label("Add ingredient", systemImage: "plus").frame(maxWidth: .infinity).padding(14) }.background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                    Button("Duplicate recipe") { commitName(); store.perform { if let copy = try store.duplicateRecipe(id: recipeID) { recipeID = copy.id; name = copy.data.name } } }.padding(14).frame(maxWidth: .infinity).background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                    Button("Delete recipe", role: .destructive) { deleting = true }.padding(14).frame(maxWidth: .infinity).background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                } else { ContentUnavailableView("Recipe not found", systemImage: "book.closed") }
                if let error = store.error { Text(error).font(.caption).foregroundStyle(.red) }
            }.padding(16)
        }.background(Theme.background).scrollDismissesKeyboard(.interactively)
            .onAppear { name = recipe?.data.name ?? "" }
            .onDisappear(perform: commitName)
            .sheet(isPresented: $adding) { FoodSearchView(meal: .breakfast, day: LocalDay.key(), recipeID: recipeID) }
            .confirmationDialog("Delete recipe?", isPresented: $deleting, titleVisibility: .visible) { Button("Delete", role: .destructive) { store.perform { try store.deleteRecipe(id: recipeID) }; dismiss() } } message: { Text("Logged diary entries will not be changed.") }
    }
    private func commitName() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { name = recipe?.data.name ?? ""; return }
        store.perform { try store.updateRecipe(id: recipeID) { $0.name = value } }
    }
}

struct IngredientRow: View {
    let item: RecipeItem
    let change: (Double) -> Void
    let remove: () -> Void
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation { expanded.toggle() } } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 3) { Text(item.foodName).foregroundStyle(.primary); Text([Portion.label(item.portion), item.brand, item.serving].compactMap { $0 }.joined(separator: " • ")).font(.caption).foregroundStyle(.secondary); MacroBadges(nutrition: item.nutrition, multiplier: item.portion) }.frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(.secondary)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Edit ingredient \(item.foodName)")
            if expanded { PortionControl(value: Binding(get: { item.portion }, set: change)); Button("Remove", role: .destructive, action: remove).accessibilityLabel("Remove \(item.foodName)") }
        }.padding(.vertical, 12)
    }
}
