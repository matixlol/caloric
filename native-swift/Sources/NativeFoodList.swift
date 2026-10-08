import SwiftUI
import UIKit

/// Keep meal cards in the diary's scroll view, with UIKit owning row swipe actions.
struct NativeFoodList: UIViewRepresentable {
    let rows: [FoodRecord]
    let meal: Meal
    let draggedID: String?
    let edit: (String) -> Void
    let delete: (String) -> Void
    let move: (String, Meal) -> Void
    let framesChanged: ([String: CGRect]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIView(context: Context) -> FoodTableView {
        let table = FoodTableView(frame: .zero, style: .plain)
        table.backgroundColor = .clear
        table.isScrollEnabled = false
        table.showsVerticalScrollIndicator = false
        table.contentInsetAdjustmentBehavior = .never
        table.separatorInset = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
        table.separatorColor = .separator
        table.tableHeaderView = UIView(frame: .zero)
        table.tableFooterView = UIView(frame: .zero)
        table.register(UITableViewCell.self, forCellReuseIdentifier: "food")
        table.delegate = context.coordinator
        table.dataSource = context.coordinator
        table.layoutChanged = { [weak coordinator = context.coordinator] in coordinator?.reportFrames() }
        context.coordinator.table = table
        return table
    }
    func updateUIView(_ table: FoodTableView, context: Context) {
        let coordinator = context.coordinator
        let previous = coordinator.parent.rows
        let appearanceChanged = coordinator.parent.draggedID != draggedID || coordinator.parent.meal != meal
        coordinator.parent = self
        coordinator.pruneHeightCache()
        if draggedID != nil { table.setEditing(false, animated: true) }
        if previous.map(\.id) != rows.map(\.id) {
            // Reordering previews move between meal tables; let SwiftUI animate the cards.
            // A deletion uses the table's standard removal animation.
            let removed = previous.enumerated().filter { old in !rows.contains { $0.id == old.element.id } }
            if draggedID == nil, removed.count == 1,
               previous.count == rows.count + 1,
               previous.filter({ $0.id != removed[0].element.id }).map(\.id) == rows.map(\.id) {
                table.deleteRows(at: [IndexPath(row: removed[0].offset, section: 0)], with: .automatic)
            } else { table.reloadData() }
        } else if previous != rows {
            table.reloadData()
        }
        if appearanceChanged || previous != rows {
            for index in rows.indices {
                if let cell = table.cellForRow(at: IndexPath(row: index, section: 0)) { coordinator.configure(cell, row: rows[index]) }
            }
        }
        if appearanceChanged || previous != rows { table.setNeedsLayout() }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: FoodTableView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let height = rows.reduce(CGFloat.zero) { $0 + context.coordinator.height(for: $1, width: width) }
        return CGSize(width: width, height: height)
    }
    static func dismantleUIView(_ table: FoodTableView, coordinator: Coordinator) {
        coordinator.scrollObservation = nil
        table.layoutChanged = nil
    }

    final class FoodTableView: UITableView {
        var layoutChanged: (() -> Void)?
        override func layoutSubviews() { super.layoutSubviews(); layoutChanged?() }
        override func didMoveToWindow() { super.didMoveToWindow(); layoutChanged?() }
    }

    final class Coordinator: NSObject, UITableViewDataSource, UITableViewDelegate {
        var parent: NativeFoodList
        weak var table: FoodTableView?
        var scrollObservation: NSKeyValueObservation?
        private weak var observedScroll: UIScrollView?
        private var lastFrames: [String: CGRect] = [:]
        private var heightCache: [String: (FoodRecord, CGFloat, CGFloat)] = [:]
        init(parent: NativeFoodList) { self.parent = parent }
        func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { parent.rows.count }
        func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
            let cell = tableView.dequeueReusableCell(withIdentifier: "food", for: indexPath)
            configure(cell, row: parent.rows[indexPath.row])
            return cell
        }
        func configure(_ cell: UITableViewCell, row: FoodRecord) {
            let dragging = row.id == parent.draggedID
            cell.backgroundColor = .clear
            cell.selectionStyle = .default
            cell.contentConfiguration = UIHostingConfiguration {
                FoodRowContent(row: row).foregroundStyle(Theme.label).opacity(dragging ? 0 : 1)
                    .background(dragging ? Theme.tint.opacity(0.08) : .clear)
            }.margins(.all, 0)
            cell.isAccessibilityElement = !dragging
            cell.accessibilityElementsHidden = dragging
            cell.accessibilityTraits = .button
            cell.accessibilityLabel = "Edit \(row.data.foodName)"
            cell.accessibilityValue = "\(row.data.meta), \(Int(((row.data.nutrition?.calories ?? 0) * row.data.portion).rounded())) calories"
            cell.accessibilityIdentifier = "diary-row-\(parent.meal.rawValue)-\(row.data.foodName)"
            cell.accessibilityCustomActions = [UIAccessibilityCustomAction(name: "Delete") { [weak self] _ in
                self?.parent.delete(row.id); return true
            }] + Meal.allCases.filter { $0 != parent.meal }.map { destination in
                UIAccessibilityCustomAction(name: "Move to \(destination.label)") { [weak self] _ in
                    self?.parent.move(row.id, destination); return true
                }
            }
        }
        func pruneHeightCache() {
            let ids = Set(parent.rows.map(\.id))
            heightCache = heightCache.filter { ids.contains($0.key) }
        }
        func height(for row: FoodRecord, width: CGFloat) -> CGFloat {
            if let cached = heightCache[row.id], cached.0 == row, cached.1 == width { return cached.2 }
            let content = UIHostingController(rootView: FoodRowContent(row: row))
            let height = ceil(content.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height)
            let result = max(52, height)
            heightCache[row.id] = (row, width, result)
            return result
        }
        func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
            height(for: parent.rows[indexPath.row], width: tableView.bounds.width)
        }
        func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
            tableView.deselectRow(at: indexPath, animated: false)
            guard parent.draggedID == nil else { return }
            parent.edit(parent.rows[indexPath.row].id)
        }
        func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
            guard parent.draggedID == nil else { return nil }
            let id = parent.rows[indexPath.row].id
            let delete = UIContextualAction(style: .destructive, title: "Delete") { [weak self] _, _, completion in
                self?.parent.delete(id)
                completion(true)
            }
            delete.image = UIImage(systemName: "trash")
            let actions = UISwipeActionsConfiguration(actions: [delete])
            actions.performsFirstActionWithFullSwipe = true
            return actions
        }
        func reportFrames() {
            guard let table, let window = table.window else { return }
            // The outer scroll view changes global row positions without relaying out cells.
            var ancestor = table.superview
            var outer: UIScrollView?
            while let view = ancestor {
                if let scroll = view as? UIScrollView { outer = scroll; break }
                ancestor = view.superview
            }
            if observedScroll !== outer {
                observedScroll = outer
                scrollObservation = outer?.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in self?.reportFrames() }
            }
            let frames = Dictionary(uniqueKeysWithValues: parent.rows.enumerated().map { index, row in
                (row.id, table.convert(table.rectForRow(at: IndexPath(row: index, section: 0)), to: window))
            })
            guard frames != lastFrames else { return }
            lastFrames = frames
            DispatchQueue.main.async { [weak self] in
                guard let self, self.lastFrames == frames else { return }
                self.parent.framesChanged(frames)
            }
        }
    }
}
