import PhotosUI
import SwiftUI

/// Food assistant: text, hold-to-talk voice notes, photos (library, camera, paste, drag and drop)
/// and compact food review. The home composer opens the conversation in a native sheet.
struct AssistantView: View {
    let chat: AILogService
    let voice: VoiceRecorder
    var isPresented = true
    @Environment(AppStore.self) private var store
    @State private var draft = AssistantDraft()
    @State private var open = false
    @State private var detent: PresentationDetent = .medium
    @State private var focusOnOpen = false
    @Namespace private var glassNamespace
    @FocusState private var homeFocus: Bool

    var body: some View {
        // Home dock: tapping the field opens the conversation sheet; the mic and photo button work in place.
        LiquidGlassGroup {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                AssistantComposerBar(chat: chat, voice: voice, draft: draft, focus: $homeFocus, glassNamespace: glassNamespace,
                                     openField: { show(focus: true) }, sendText: submitText, sendVoice: submitVoice)
                    .background { DockFade() }
            }.padding(.bottom, 6)
        }
        .modifier(AssistantPickers(draft: draft, active: !open))
        .sheet(isPresented: $open) {
            AssistantConversationScreen(chat: chat, voice: voice, draft: draft, detent: $detent,
                                        focusOnOpen: $focusOnOpen, sendText: submitText, sendVoice: submitVoice)
        }
        .onChange(of: isPresented) { _, presented in if !presented { homeFocus = false; open = false } }
        .onChange(of: draft.loading) { old, new in
            // Photos picked from the home composer open the conversation once the picker has gone.
            guard new > old, !open else { return }
            Task { try? await Task.sleep(for: .milliseconds(450)); show(focus: false) }
        }
        .onAppear {
            #if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            if AppConfiguration.uiTesting {
                if arguments.contains("-seed-ai-attachments") { draft.attachments = AssistantDemo.images(count: 2) }
                if arguments.contains("-ai-panel-open") || arguments.contains("-seed-chat") || arguments.contains("-seed-chat-activity") { open = true }
                if arguments.contains("-ai-panel-expanded") { open = true; detent = .large }
                if arguments.contains("-ai-focus") { focusOnOpen = true }
            }
            #endif
        }
    }

    private func show(focus: Bool) {
        focusOnOpen = focus
        open = true
    }

    private func submitText() {
        let text = draft.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !draft.attachments.isEmpty, draft.loading == 0, !chat.streaming else { return }
        let images = draft.take()
        draft.input = ""; homeFocus = false
        chat.submit(text, store: store, images: images)
        show(focus: false)
    }

    private func submitVoice(_ audio: URL, _ duration: String) {
        chat.submit("", store: store, audio: audio, duration: duration, images: draft.take())
        show(focus: false)
    }
}

// MARK: - Shared state

/// Text and photos waiting to be sent, shared by the home dock and the conversation sheet.
@MainActor @Observable
final class AssistantDraft {
    enum Source { case item(PhotosPickerItem), data(Data), image(UIImage) }

    var input = ""
    var attachments: [AssistantImage] = []
    var loading = 0
    var error: String?
    var showPhotoPicker = false
    var showCamera = false
    var viewer: ImageViewerItem?
    var dropTargeted = false
    var photoItems: [PhotosPickerItem] = [] {
        didSet {
            guard !photoItems.isEmpty else { return }
            let items = photoItems
            photoItems = []
            add(items.map { .item($0) })
        }
    }

    var isFull: Bool { attachments.count + loading >= AssistantImageProcessor.maxAttachments }

    func take() -> [AssistantImage] {
        defer { attachments = []; error = nil }
        return attachments
    }

    func remove(_ image: AssistantImage) { attachments.removeAll { $0.id == image.id } }

    func paste() {
        let images = UIPasteboard.general.images ?? []
        if !images.isEmpty { add(images.map { .image($0) }) }
    }

    func add(_ sources: [Source]) {
        let room = AssistantImageProcessor.maxAttachments - attachments.count - loading
        guard room > 0 else { error = "You can attach up to \(AssistantImageProcessor.maxAttachments) photos per message."; return }
        let accepted = Array(sources.prefix(room))
        error = sources.count > room ? "Only the first \(AssistantImageProcessor.maxAttachments) photos were attached." : nil
        loading += accepted.count
        Task {
            var failed = false
            for source in accepted {
                let image: AssistantImage?
                switch source {
                case let .item(item):
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        image = await Task.detached(priority: .userInitiated) { AssistantImageProcessor.prepare(data) }.value
                    } else { image = nil }
                case let .data(data): image = await Task.detached(priority: .userInitiated) { AssistantImageProcessor.prepare(data) }.value
                case let .image(picture): image = await Task.detached(priority: .userInitiated) { AssistantImageProcessor.prepare(picture) }.value
                }
                loading = max(0, loading - 1)
                if let image { attachments.append(image) } else { failed = true }
            }
            if failed { error = "A photo could not be read. Try another one." }
        }
    }
}

/// Photo library, camera and photo viewer. Only the top-most presenter may be active.
private struct AssistantPickers: ViewModifier {
    @Bindable var draft: AssistantDraft
    let active: Bool
    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: Binding(get: { active && draft.showPhotoPicker }, set: { draft.showPhotoPicker = $0 }),
                          selection: $draft.photoItems,
                          maxSelectionCount: max(1, AssistantImageProcessor.maxAttachments - draft.attachments.count),
                          selectionBehavior: .ordered, matching: .images, preferredItemEncoding: .compatible)
            .fullScreenCover(isPresented: Binding(get: { active && draft.showCamera }, set: { draft.showCamera = $0 })) {
                CameraPicker { image in draft.add([.image(image)]) }.ignoresSafeArea()
            }
            .fullScreenCover(item: Binding(get: { active ? draft.viewer : nil }, set: { draft.viewer = $0 })) { AssistantImageViewer(item: $0) }
    }
}

// MARK: - Conversation sheet

private struct AssistantConversationScreen: View {
    let chat: AILogService
    let voice: VoiceRecorder
    let draft: AssistantDraft
    @Binding var detent: PresentationDetent
    @Binding var focusOnOpen: Bool
    let sendText: () -> Void
    let sendVoice: (URL, String) -> Void
    @FocusState private var focus: Bool
    @Namespace private var glassNamespace

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                AssistantTitle()
                Spacer(minLength: 4)
                AssistantHeaderButton(symbol: "square.and.pencil", label: "New chat", identifier: "ai-new-chat") {
                    chat.startNewConversation(); draft.error = nil
                }.disabled(chat.messages.isEmpty && chat.error == nil || chat.streaming)
            }
            .padding(.leading, 20).padding(.trailing, 10).padding(.top, 18).padding(.bottom, 2)
            AssistantConversation(chat: chat, draft: draft)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            LiquidGlassGroup {
                AssistantComposerBar(chat: chat, voice: voice, draft: draft, focus: $focus, glassNamespace: glassNamespace,
                                     sendText: { focus = false; sendText() }, sendVoice: sendVoice)
            }.padding(.bottom, 2)
        }
        .modifier(AssistantPickers(draft: draft, active: true))
        .presentationDetents(detents, selection: $detent)
        .presentationBackground(Theme.background)
        .presentationDragIndicator(.visible)
        .presentationContentInteraction(.scrolls)
        .interactiveDismissDisabled(voice.recording || voice.starting)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ai-panel")
        .onAppear {
            detent = isEmpty ? compact : detent == .large ? .large : .medium
            if focusOnOpen { focusOnOpen = false; focus = true }
        }
        .onChange(of: isEmpty) { _, empty in
            withAnimation(.smooth) { detent = empty ? compact : .medium }
        }
        .onChange(of: compact) { old, new in if detent == old { withAnimation(.smooth) { detent = new } } }
    }

    /// Just tall enough for the title, the prompt, pending photos and the composer.
    private var compact: PresentationDetent { .height(draft.attachments.isEmpty && draft.loading == 0 && draft.error == nil ? 268 : 372) }
    private var isEmpty: Bool { chat.messages.isEmpty && !chat.streaming && chat.error == nil }
    private var detents: Set<PresentationDetent> {
        isEmpty ? [compact, .large] : [.medium, .large]
    }
}

// MARK: - Building blocks

/// Fades the diary out behind the home composer so rows never collide with the controls.
private struct DockFade: View {
    var body: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [Theme.background.opacity(0), Theme.background.opacity(0.94)], startPoint: .top, endPoint: .bottom)
                .frame(height: 56)
            Theme.background.opacity(0.94)
        }
        .padding(.top, -56).padding(.bottom, -40).ignoresSafeArea(edges: .bottom)
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

private struct AssistantTitle: View {
    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "sparkles").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.tint)
                .accessibilityHidden(true)
            Text("Assistant").font(.headline)
        }
    }
}

private struct AssistantHeaderButton: View {
    let symbol: String
    let label: String
    let identifier: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary)
                .frame(width: 32, height: 32).background(Color.primary.opacity(0.07), in: Circle())
                .frame(width: 40, height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(label).accessibilityIdentifier(identifier)
    }
}

/// Text field, hold-to-talk mic, photo button and pending photos.
private struct AssistantComposerBar: View {
    let chat: AILogService
    let voice: VoiceRecorder
    @Bindable var draft: AssistantDraft
    var focus: FocusState<Bool>.Binding
    let glassNamespace: Namespace.ID
    var openField: (() -> Void)? = nil
    let sendText: () -> Void
    let sendVoice: (URL, String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VoiceComposer(input: $draft.input, voice: voice, focus: focus, disabled: chat.streaming, sendText: sendText, sendVoice: sendVoice,
                      glassNamespace: glassNamespace, hasAttachments: !draft.attachments.isEmpty, sendEnabled: draft.loading == 0,
                      placeholder: "What did you eat?", openField: openField) {
            attachButton
        } accessory: {
            if !draft.attachments.isEmpty || draft.loading > 0 {
                AttachmentStrip(images: draft.attachments, loading: draft.loading, remove: draft.remove,
                                open: { index in draft.viewer = ImageViewerItem(images: draft.attachments, index: index) })
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            if let error = draft.error {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
            }
        }
        .dropDestination(for: DroppedImage.self) { items, _ in
            guard !items.isEmpty else { return false }
            draft.add(items.map { .data($0.data) })
            return true
        } isTargeted: { targeted in withAnimation(reduceMotion ? nil : .smooth(duration: 0.18)) { draft.dropTargeted = targeted } }
        .overlay {
            if draft.dropTargeted {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .strokeBorder(Theme.tint, style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
                    .background(Theme.tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                    .overlay(Label("Drop to attach", systemImage: "photo.on.rectangle.angled").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.tint))
                    .padding(.horizontal, 6).allowsHitTesting(false)
            }
        }
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: draft.attachments.count + draft.loading)
    }

    private var attachButton: some View {
        Menu {
            Button { draft.showPhotoPicker = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
            if CameraPicker.isAvailable {
                Button { draft.showCamera = true } label: { Label("Take Photo", systemImage: "camera") }
            }
            if UIPasteboard.general.hasImages {
                Button { draft.paste() } label: { Label("Paste Photo", systemImage: "doc.on.clipboard") }
            }
        } label: {
            Image(systemName: "plus").font(.system(size: 20, weight: .semibold)).foregroundStyle(.primary)
                .frame(width: 48, height: 48)
                .caloricGlass(in: Circle(), interactive: true)
                .glassIdentity("composer-attach", in: glassNamespace)
        }
        .menuOrder(.fixed)
        .disabled(draft.isFull)
        .opacity(draft.isFull ? 0.5 : 1)
        .accessibilityLabel("Add photos")
        .accessibilityHint("Attach up to four photos of your meal or a nutrition label")
        .accessibilityIdentifier("ai-attach")
    }
}

/// Scrolling list of messages, anchored to the latest one.
private struct AssistantConversation: View {
    let chat: AILogService
    let draft: AssistantDraft
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if chat.messages.isEmpty && !chat.streaming && chat.error == nil { AssistantEmptyState(draft: draft) }
                    ForEach(chat.messages) { message in AssistantMessageView(message: message, chat: chat, draft: draft) }
                    if let activity = chat.activity { ActivityRow(text: activity).transition(.opacity) }
                    if let error = chat.error { errorRow(error) }
                    Color.clear.frame(height: 1).id("chat-bottom")
                }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 10)
                    .animation(reduceMotion ? nil : .smooth(duration: 0.22), value: chat.messages.count)
            }
            .scrollDismissesKeyboard(.interactively).scrollIndicators(.hidden)
            .defaultScrollAnchor(chat.messages.isEmpty ? .top : .bottom)
            .onChange(of: chat.messages.count) { _, _ in withAnimation(reduceMotion ? nil : .smooth) { proxy.scrollTo("chat-bottom", anchor: .bottom) } }
            .onChange(of: chat.messages.last?.text) { _, _ in proxy.scrollTo("chat-bottom", anchor: .bottom) }
            .onChange(of: chat.activity) { _, _ in withAnimation(reduceMotion ? nil : .smooth) { proxy.scrollTo("chat-bottom", anchor: .bottom) } }
        }
    }

    private func errorRow(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(text).font(.footnote).foregroundStyle(Theme.label).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(12).background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .combine)
    }
}

/// Short prompt with two photo shortcuts; small enough for the half-height sheet.
private struct AssistantEmptyState: View {
    let draft: AssistantDraft
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("What did you eat?").font(.title3.weight(.bold))
                Text("Type it, hold the mic to talk, or add a photo of your plate or a nutrition label.")
                    .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                if CameraPicker.isAvailable { shortcut("camera.fill", "Take photo") { draft.showCamera = true } }
                shortcut("photo.on.rectangle", "Choose photo") { draft.showPhotoPicker = true }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("ai-empty-state")
    }
    private func shortcut(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.label)
                .padding(.horizontal, 14).frame(height: 40)
                .background(Theme.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.separator.opacity(0.6), lineWidth: 0.5))
        }.buttonStyle(.plain).accessibilityIdentifier("ai-empty-shortcut")
    }
}

private struct AssistantMessageView: View {
    let message: ChatMessage
    let chat: AILogService
    let draft: AssistantDraft
    var body: some View {
        switch message.kind {
        case "text" where message.role == "user", "audio": userBubble
        case "text":
            Text((try? AttributedString(markdown: message.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(message.text))
                .font(.body).foregroundStyle(Theme.label).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 2)
        case "search": SearchResultsChip(message: message)
        case "approval": AssistantApprovalCard(message: message, chat: chat)
        default: EmptyView()
        }
    }

    private var userBubble: some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous)
        return HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 6) {
                if !message.images.isEmpty {
                    MessageImages(images: message.images) { index in draft.viewer = ImageViewerItem(images: message.images, index: index) }
                }
                if message.kind == "audio" {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 10) {
                            Image(systemName: "waveform").font(.system(size: 13, weight: .bold))
                                .frame(width: 30, height: 30).background(.white.opacity(0.18), in: Circle())
                            Waveform(color: Theme.onTint)
                            Text(message.duration ?? "0:00").font(.footnote.weight(.semibold)).monospacedDigit().opacity(0.85)
                        }
                        if message.text != "Voice message" && !message.text.isEmpty {
                            Text(message.text).font(.body).textSelection(.enabled)
                        }
                    }.padding(.horizontal, 14).padding(.vertical, 10).foregroundStyle(Theme.onTint)
                        .background(Theme.tint, in: shape)
                        .accessibilityElement(children: .combine).accessibilityLabel("Voice message, \(message.duration ?? "")")
                } else if !message.text.isEmpty {
                    Text(message.text).font(.body).textSelection(.enabled).foregroundStyle(Theme.onTint)
                        .padding(.horizontal, 14).padding(.vertical, 10).background(Theme.tint, in: shape)
                }
            }
        }
    }
}

// MARK: - Subviews

private struct MessageImages: View {
    let images: [AssistantImage]
    let open: (Int) -> Void
    var body: some View {
        if images.count == 1, let image = images.first {
            let width: CGFloat = 210
            tile(image, index: 0, width: width, height: min(280, max(140, width / max(0.4, image.aspectRatio))), corner: 20)
        } else {
            let columns = [GridItem(.fixed(104), spacing: 4), GridItem(.fixed(104), spacing: 4)]
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(Array(images.enumerated()), id: \.element.id) { index, image in
                    tile(image, index: index, width: 104, height: images.count == 2 ? 136 : 104, corner: 6)
                }
            }.frame(width: 212).clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }
    private func tile(_ image: AssistantImage, index: Int, width: CGFloat, height: CGFloat, corner: CGFloat) -> some View {
        Button { open(index) } label: {
            Image(uiImage: image.preview).resizable().scaledToFill().frame(width: width, height: height)
                .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
                .contentShape(Rectangle())
        }.buttonStyle(.plain)
            .accessibilityLabel("Photo \(index + 1) of \(images.count)").accessibilityHint("Opens the photo full screen")
            .accessibilityIdentifier("ai-message-image")
    }
}

private struct Waveform: View {
    let color: Color
    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array([7.0, 12, 9, 16, 11, 18, 8, 14, 10, 13, 7, 11].enumerated()), id: \.offset) { _, height in
                Capsule().fill(color.opacity(0.9)).frame(width: 2.5, height: height)
            }
        }.accessibilityHidden(true)
    }
}

/// Compact "what the assistant is doing" row with a shimmer that respects Reduce Motion.
private struct ActivityRow: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 9) {
            TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                Image(systemName: "sparkle").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.tint)
                    .scaleEffect(reduceMotion ? 1 : 0.82 + 0.18 * abs(sin(t * 2.4)))
                    .opacity(reduceMotion ? 1 : 0.65 + 0.35 * abs(sin(t * 2.4)))
            }.frame(width: 16, height: 16)
            Text(text).font(.subheadline.weight(.medium)).foregroundStyle(.secondary).lineLimit(2)
                .modifier(Shimmer(active: !reduceMotion))
                .contentTransition(.opacity)
        }.padding(.vertical, 2).frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine).accessibilityIdentifier("ai-activity")
    }
}

private struct Shimmer: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if active {
            content.overlay {
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                    GeometryReader { geometry in
                        LinearGradient(colors: [.clear, Theme.label.opacity(0.75), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: geometry.size.width * 0.45)
                            .offset(x: (geometry.size.width * 1.45) * phase - geometry.size.width * 0.45)
                    }
                }.mask(content).allowsHitTesting(false)
            }
        } else { content }
    }
}

/// Collapsible chip that reveals the foods the assistant looked at.
private struct SearchResultsChip: View {
    let message: ChatMessage
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(reduceMotion ? nil : .smooth(duration: 0.25)) { expanded.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 11, weight: .bold))
                    (Text("Searched ") + Text(message.query ?? message.foods.first?.name ?? "foods").fontWeight(.semibold).foregroundColor(Theme.label))
                        .lineLimit(1)
                    if !message.foods.isEmpty {
                        Text("\(message.foods.count)").font(.caption2.weight(.bold)).monospacedDigit()
                            .padding(.horizontal, 6).padding(.vertical, 2).background(Color.primary.opacity(0.08), in: Capsule())
                    }
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).rotationEffect(.degrees(expanded ? 180 : 0))
                }.font(.footnote).foregroundStyle(.secondary)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Color.primary.opacity(0.06), in: Capsule())
            }.buttonStyle(.plain).disabled(message.foods.isEmpty)
                .accessibilityLabel("Searched for \(message.query ?? "foods"), \(message.foods.count) results")
                .accessibilityHint(expanded ? "Hide search results" : "Show search results")
                .accessibilityIdentifier("ai-search-chip")
            if expanded {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(message.foods) { food in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(food.name).font(.footnote.weight(.semibold)).lineLimit(2).multilineTextAlignment(.leading)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text([food.sourceLabel, food.brand, food.serving].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                Spacer(minLength: 0)
                                if let calories = food.nutrition?.calories {
                                    Text("\(Int(calories.rounded())) kcal").font(.caption.weight(.bold)).monospacedDigit()
                                }
                            }.padding(10).frame(width: 150, height: 92, alignment: .topLeading)
                                .background(Theme.card.opacity(0.85), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                .accessibilityElement(children: .combine)
                        }
                    }
                }.scrollIndicators(.hidden).scrollClipDisabled()
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

#if DEBUG
/// Deterministic fixtures for UI tests and screenshots.
enum AssistantDemo {
    static func images(count: Int) -> [AssistantImage] {
        (0..<count).compactMap { index in
            let size = CGSize(width: 900, height: 700)
            let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
            let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
                let cg = context.cgContext
                let table = index % 2 == 0 ? UIColor(red: 0.55, green: 0.38, blue: 0.24, alpha: 1) : UIColor(red: 0.26, green: 0.36, blue: 0.42, alpha: 1)
                table.setFill(); cg.fill(CGRect(origin: .zero, size: size))
                UIColor(white: 0, alpha: 0.18).setFill(); cg.fillEllipse(in: CGRect(x: 170, y: 105, width: 580, height: 540))
                UIColor(white: 0.97, alpha: 1).setFill(); cg.fillEllipse(in: CGRect(x: 160, y: 80, width: 580, height: 540))
                UIColor(white: 0.9, alpha: 1).setFill(); cg.fillEllipse(in: CGRect(x: 230, y: 150, width: 440, height: 400))
                if index % 2 == 0 {
                    for (x, y) in [(270.0, 210.0), (420.0, 320.0)] {
                        UIColor.white.setFill(); cg.fillEllipse(in: CGRect(x: x, y: y, width: 200, height: 160))
                        UIColor(red: 1, green: 0.72, blue: 0.1, alpha: 1).setFill(); cg.fillEllipse(in: CGRect(x: x + 65, y: y + 45, width: 70, height: 70))
                    }
                    UIColor(red: 0.78, green: 0.55, blue: 0.3, alpha: 1).setFill()
                    cg.addPath(UIBezierPath(roundedRect: CGRect(x: 470, y: 170, width: 170, height: 130), cornerRadius: 30).cgPath); cg.fillPath()
                } else {
                    UIColor(red: 0.95, green: 0.9, blue: 0.8, alpha: 1).setFill(); cg.fillEllipse(in: CGRect(x: 330, y: 230, width: 240, height: 240))
                    UIColor(red: 0.45, green: 0.28, blue: 0.15, alpha: 1).setFill(); cg.fillEllipse(in: CGRect(x: 360, y: 260, width: 180, height: 180))
                    UIColor(red: 0.98, green: 0.95, blue: 0.9, alpha: 1).setFill(); cg.fillEllipse(in: CGRect(x: 420, y: 320, width: 60, height: 50))
                }
            }
            return AssistantImageProcessor.prepare(image)
        }
    }

    static func activity() -> [ChatMessage] {
        [
            ChatMessage(kind: "text", role: "user", text: "Lunch was a chicken wrap"),
            ChatMessage(kind: "text", text: "Added the **chicken wrap** to lunch. Anything else?"),
            ChatMessage(kind: "audio", role: "user", text: "A banana and a small Greek yogurt as a snack", duration: "0:04"),
            ChatMessage(kind: "search", query: "banana", foods: [
                SearchFood(id: "demo-banana", canonicalKey: "demo-banana", source: "mfp", sourceLabel: "MFP", name: "Banana", serving: "1 medium (118 g)", nutrition: Nutrition(calories: 105, protein: 1.3, carbs: 27, fat: 0.4)),
            ]),
        ]
    }

    static func conversation() -> [ChatMessage] {
        let egg = SearchFood(id: "demo-egg", canonicalKey: "demo-egg", source: "mfp", sourceLabel: "MFP", name: "Fried egg", brand: nil, serving: "1 large (46 g)",
                             nutrition: Nutrition(calories: 90, protein: 6.3, carbs: 0.4, fat: 6.8), resultId: "r1")
        let toast = SearchFood(id: "demo-toast", canonicalKey: "demo-toast", source: "mfp", sourceLabel: "MFP", name: "Sourdough toast", brand: "Bakery", serving: "1 slice (50 g)",
                               nutrition: Nutrition(calories: 130, protein: 5.2, carbs: 25, fat: 0.9), resultId: "r2")
        let poached = SearchFood(id: "demo-poached", canonicalKey: "demo-poached", source: "off", sourceLabel: "OFF", name: "Poached egg", brand: nil, serving: "1 large (50 g)",
                                 nutrition: Nutrition(calories: 72, protein: 6.3, carbs: 0.4, fat: 4.8), resultId: "r3")
        return [
            { var message = ChatMessage(kind: "text", role: "user", text: "Breakfast today"); message.images = images(count: 1); return message }(),
            ChatMessage(kind: "search", query: "fried egg", foods: [egg, poached, toast]),
            ChatMessage(kind: "text", text: "I can see **2 fried eggs** and a slice of sourdough toast. Adjust anything below, then add them to breakfast."),
            ChatMessage(kind: "approval", toolCallID: "demo-call", suggestions: [
                FoodSuggestion(suggestionId: "demo-s1", resultId: "r1", meal: .breakfast, portion: 2, reason: "Two large eggs fried in a little oil.", food: egg),
                FoodSuggestion(suggestionId: "demo-s2", resultId: "r2", meal: .breakfast, portion: 1, reason: "One slice of toast next to the eggs.", food: toast),
            ]),
        ]
    }
}
#endif
