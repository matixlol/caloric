import PhotosUI
import SwiftUI

/// Shadow-flagged food assistant: photos, drag and drop, and a larger conversation panel.
/// The home composer (text field + hold-to-talk microphone) keeps the classic gestures.
struct AssistantNextView: View {
    let chat: AILogService
    let voice: VoiceRecorder
    var isPresented = true
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var input = ""
    @State private var attachments: [AssistantImage] = []
    @State private var loadingAttachments = 0
    @State private var panelOpen = false
    @State private var expanded = false
    @State private var dragOffset: CGFloat = 0
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var viewer: ImageViewerItem?
    @State private var dropTargeted = false
    @State private var attachmentError: String?
    @Namespace private var glassNamespace
    @FocusState private var inputFocused: Bool

    var body: some View {
        GeometryReader { geometry in
            LiquidGlassGroup {
                VStack(spacing: 8) {
                    Spacer(minLength: 0)
                    if panelOpen {
                        panel(available: geometry.size.height)
                            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    }
                    composer
                }.padding(.bottom, 6)
                    .dropDestination(for: DroppedImage.self) { items, _ in
                        let data = items.map(\.data)
                        guard !data.isEmpty else { return false }
                        addAttachments(data.map { .data($0) })
                        return true
                    } isTargeted: { targeted in withAnimation(reduceMotion ? nil : .smooth(duration: 0.18)) { dropTargeted = targeted } }
            }
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems,
                      maxSelectionCount: max(1, AssistantImageProcessor.maxAttachments - attachments.count),
                      selectionBehavior: .ordered, matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            addAttachments(items.map { .item($0) })
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in addAttachments([.image(image)]) }.ignoresSafeArea()
        }
        .fullScreenCover(item: $viewer) { AssistantImageViewer(item: $0) }
        .onChange(of: inputFocused) { _, focused in if focused { open() } }
        .onChange(of: isPresented) { _, presented in if !presented { inputFocused = false } }
        .onAppear {
            #if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            if AppConfiguration.uiTesting {
                if arguments.contains("-seed-ai-attachments") { attachments = AssistantDemo.images(count: 2) }
                if arguments.contains("-ai-panel-open") || arguments.contains("-seed-chat-next") || arguments.contains("-seed-chat-next-activity") { panelOpen = true }
                if arguments.contains("-ai-panel-expanded") { panelOpen = true; expanded = true }
            }
            #endif
        }
    }

    // MARK: Panel

    private func panel(available: CGFloat) -> some View {
        let compact = min(500, max(260, available * 0.56))
        let target = expanded ? available : compact
        return VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if chat.messages.isEmpty && !chat.streaming && chat.error == nil { emptyState }
                        ForEach(chat.messages) { message in
                            messageView(message).transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
                        }
                        if let activity = chat.activity { ActivityRow(text: activity).transition(.opacity) }
                        if let error = chat.error ?? attachmentError { errorRow(error) }
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }.padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 14)
                        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: chat.messages.count)
                        .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: chat.activity)
                }.scrollDismissesKeyboard(.interactively).scrollIndicators(.hidden)
                    .mask {
                        VStack(spacing: 0) {
                            LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: 14)
                            Color.black
                        }
                    }
                    .onAppear { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                    .onChange(of: chat.messages.count) { _, _ in withAnimation(reduceMotion ? nil : .smooth) { proxy.scrollTo("chat-bottom", anchor: .bottom) } }
                    .onChange(of: chat.messages.last?.text) { _, _ in proxy.scrollTo("chat-bottom", anchor: .bottom) }
                    .onChange(of: chat.activity) { _, _ in withAnimation(reduceMotion ? nil : .smooth) { proxy.scrollTo("chat-bottom", anchor: .bottom) } }
                    .onChange(of: expanded) { _, _ in proxy.scrollTo("chat-bottom", anchor: .bottom) }
                    .onChange(of: inputFocused) { _, focused in if focused { withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) } } }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: min(200, target), maxHeight: max(200, target - dragOffset))
        .background(Theme.background.opacity(0.4), in: RoundedRectangle(cornerRadius: 30, style: .continuous))
        .caloricGlass(in: RoundedRectangle(cornerRadius: 30, style: .continuous))
        .glassIdentity("conversation", in: glassNamespace)
        .padding(.horizontal, 10)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ai-next-panel")
    }

    private var header: some View {
        VStack(spacing: 4) {
            Capsule().fill(Color.secondary.opacity(0.45)).frame(width: 36, height: 5).padding(.top, 7)
                .accessibilityHidden(true)
            HStack(spacing: 8) {
                Image(systemName: "sparkles").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.tint)
                    .accessibilityHidden(true)
                Text("Assistant").font(.headline)
                Text("LABS").font(.system(size: 10, weight: .heavy)).tracking(0.8)
                    .foregroundStyle(Theme.tint).padding(.horizontal, 6).padding(.vertical, 3)
                    .background(Theme.tint.opacity(0.14), in: Capsule())
                    .accessibilityLabel("Labs preview")
                Spacer(minLength: 4)
                headerButton("square.and.pencil", label: "New chat", identifier: "ai-new-chat") {
                    withAnimation(reduceMotion ? nil : .smooth) { chat.startNewConversation(); attachmentError = nil }
                }.disabled(chat.messages.isEmpty && chat.error == nil)
                headerButton(expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                             label: expanded ? "Shrink the assistant" : "Expand the assistant", identifier: "ai-expand") {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86)) { expanded.toggle() }
                }
                headerButton("chevron.down", label: "Hide the food assistant conversation", identifier: "ai-collapse") { close() }
            }.padding(.leading, 18).padding(.trailing, 10).padding(.bottom, 4)
        }
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 6)
            .onChanged { value in dragOffset = expanded ? max(-40, value.translation.height) : max(-160, min(220, value.translation.height)) }
            .onEnded { value in
                let distance = value.predictedEndTranslation.height
                withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86)) {
                    if distance > 140 { if expanded && distance < 420 { expanded = false } else { close(animated: false) } }
                    else if distance < -80 { expanded = true }
                    dragOffset = 0
                }
            })
        .accessibilityAction(named: expanded ? "Shrink" : "Expand") { expanded.toggle() }
    }

    private func headerButton(_ symbol: String, label: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary)
                .frame(width: 32, height: 32).background(Color.primary.opacity(0.07), in: Circle())
                .frame(width: 40, height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(label).accessibilityIdentifier(identifier)
    }

    // MARK: Empty state

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "fork.knife").font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.onTint)
                .frame(width: 52, height: 52)
                .background(LinearGradient(colors: [Theme.tint, Theme.accent], startPoint: .topLeading, endPoint: .bottomTrailing), in: Circle())
                .accessibilityHidden(true)
            VStack(spacing: 5) {
                Text("What did you eat?").font(.title3.weight(.bold))
                Text("Describe it, hold the mic to talk, or add a photo of your plate or a nutrition label.")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(spacing: 8) {
                promptButton("camera.fill", "Snap a photo of your meal") { CameraPicker.isAvailable ? (showCamera = true) : (showPhotoPicker = true) }
                promptButton("text.bubble.fill", "2 eggs and toast for breakfast") { fill("2 eggs and toast for breakfast") }
                promptButton("cup.and.saucer.fill", "Flat white and a croissant") { fill("Flat white and a croissant") }
                promptButton("fork.knife", "Chicken burrito bowl for lunch") { fill("Chicken burrito bowl for lunch") }
            }.padding(.top, 4)
        }.frame(maxWidth: .infinity).padding(.top, 8).padding(.horizontal, 4)
            .accessibilityIdentifier("ai-empty-state")
    }

    private func promptButton(_ symbol: String, _ text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.tint).frame(width: 22)
                Text(text).font(.subheadline.weight(.medium)).foregroundStyle(Theme.label).multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Image(systemName: "arrow.up.left").font(.system(size: 12, weight: .semibold)).foregroundStyle(.tertiary)
            }.padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.card.opacity(0.85), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 16))
        }.buttonStyle(.plain).accessibilityIdentifier("ai-example-prompt")
    }

    // MARK: Messages

    @ViewBuilder private func messageView(_ message: ChatMessage) -> some View {
        switch message.kind {
        case "text" where message.role == "user": userBubble(message)
        case "audio": userBubble(message)
        case "text":
            Text((try? AttributedString(markdown: message.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(message.text))
                .font(.body).foregroundStyle(Theme.label).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 2)
        case "search": SearchResultsChip(message: message)
        case "approval": AssistantApprovalCard(message: message, chat: chat)
        default: EmptyView()
        }
    }

    private func userBubble(_ message: ChatMessage) -> some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous)
        return HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 6) {
                if !message.images.isEmpty {
                    MessageImages(images: message.images) { index in viewer = ImageViewerItem(images: message.images, index: index) }
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

    private func errorRow(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(text).font(.footnote).foregroundStyle(Theme.label).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(12).background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .combine)
    }

    // MARK: Composer

    private var composer: some View {
        VoiceComposer(input: $input, voice: voice, focus: $inputFocused, disabled: chat.streaming, sendText: sendText,
                      sendVoice: { audio, duration in
                          open()
                          let images = takeAttachments()
                          chat.submit("", store: store, audio: audio, duration: duration, images: images)
                      }, glassNamespace: glassNamespace,
                      hasAttachments: !attachments.isEmpty, sendEnabled: loadingAttachments == 0,
                      placeholder: "What did you eat?") {
            attachButton
        } accessory: {
            if !attachments.isEmpty || loadingAttachments > 0 {
                AttachmentStrip(images: attachments, loading: loadingAttachments,
                                remove: { image in attachments.removeAll { $0.id == image.id } },
                                open: { index in viewer = ImageViewerItem(images: attachments, index: index) })
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .strokeBorder(Theme.tint, style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
                    .background(Theme.tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                    .overlay(Label("Drop to attach", systemImage: "photo.on.rectangle.angled").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.tint))
                    .padding(.horizontal, 6).allowsHitTesting(false)
            }
        }
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: attachments.count + loadingAttachments)
    }

    private var attachButton: some View {
        let full = attachments.count + loadingAttachments >= AssistantImageProcessor.maxAttachments
        return Menu {
            Button { showPhotoPicker = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
            if CameraPicker.isAvailable {
                Button { showCamera = true } label: { Label("Take Photo", systemImage: "camera") }
            }
            if UIPasteboard.general.hasImages {
                Button { pasteImages() } label: { Label("Paste Photo", systemImage: "doc.on.clipboard") }
            }
        } label: {
            Image(systemName: "plus").font(.system(size: 20, weight: .semibold)).foregroundStyle(.primary)
                .frame(width: 48, height: 48)
                .caloricGlass(in: Circle(), interactive: true)
                .glassIdentity("composer-attach", in: glassNamespace)
        }
        .menuOrder(.fixed)
        .disabled(full)
        .opacity(full ? 0.5 : 1)
        .accessibilityLabel("Add photos")
        .accessibilityHint("Attach up to four photos of your meal or a nutrition label")
        .accessibilityIdentifier("ai-attach")
    }

    // MARK: Actions

    private func open() { withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86)) { panelOpen = true } }
    private func close(animated: Bool = true) {
        withAnimation(animated && !reduceMotion ? .spring(response: 0.38, dampingFraction: 0.86) : nil) {
            panelOpen = false; expanded = false; inputFocused = false
        }
    }
    private func fill(_ text: String) { input = text; inputFocused = true }

    private func sendText() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty, loadingAttachments == 0 else { return }
        open()
        let images = takeAttachments()
        input = ""; inputFocused = false
        chat.submit(text, store: store, images: images)
    }

    private func takeAttachments() -> [AssistantImage] {
        defer { attachments = []; attachmentError = nil }
        return attachments
    }

    private enum Source { case item(PhotosPickerItem), data(Data), image(UIImage) }

    private func addAttachments(_ sources: [Source]) {
        let room = AssistantImageProcessor.maxAttachments - attachments.count - loadingAttachments
        guard room > 0 else { attachmentError = "You can attach up to \(AssistantImageProcessor.maxAttachments) photos per message."; return }
        let accepted = Array(sources.prefix(room))
        attachmentError = sources.count > room ? "Only the first \(AssistantImageProcessor.maxAttachments) photos were attached." : nil
        loadingAttachments += accepted.count
        open()
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
                loadingAttachments = max(0, loadingAttachments - 1)
                if let image { attachments.append(image) } else { failed = true }
            }
            if failed { attachmentError = "A photo could not be read. Try another one." }
        }
    }

    private func pasteImages() {
        let images = UIPasteboard.general.images ?? []
        guard !images.isEmpty else { return }
        addAttachments(images.map { .image($0) })
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
