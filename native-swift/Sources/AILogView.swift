import SwiftUI

struct AILogView: View {
    var isPresented = true
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var chat = AILogService()
    @State private var voice = VoiceRecorder()
    @State private var input = ""
    @State private var expanded = Set<String>()
    @State private var panelOpen = false
    @Namespace private var glassNamespace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var inputFocused: Bool
    var body: some View {
      GeometryReader { geometry in
       LiquidGlassGroup {
       VStack(spacing: 8) {
        Spacer(minLength: 0)
        if panelOpen && (!chat.messages.isEmpty || chat.streaming || chat.error != nil) {
         VStack(spacing: 0) {
          HStack {
            Label("Food assistant", systemImage: "sparkles").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
            Spacer()
            Button { withAnimation(reduceMotion ? nil : .smooth) { panelOpen = false; inputFocused = false } } label: { Image(systemName: "chevron.down").frame(width: 44, height: 44) }.buttonStyle(.borderless).accessibilityLabel("Hide the food assistant conversation")
          }.padding(.horizontal, 14).padding(.top, 6)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(chat.messages) { message in messageView(message) }
                    if chat.streaming { HStack(spacing: 8) { ProgressView(); Text("Thinking…").font(.system(size: 14)).foregroundStyle(.secondary) }.caloricCard() }
                    if let error = chat.error { Text(error).font(.system(size: 14)).foregroundStyle(.red).caloricCard() }
                    Color.clear.frame(height: 1).id("chat-bottom")
                }.padding(.horizontal, 10).padding(.bottom, 10)
            }.scrollDismissesKeyboard(.immediately)
                .onChange(of: chat.messages.count) { _, _ in withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) } }
                .onChange(of: chat.messages.last?.text) { _, _ in proxy.scrollTo("chat-bottom", anchor: .bottom) }
                .onChange(of: inputFocused) { _, focused in if focused { withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) } } }
        }
         }.frame(height: min(480, max(150, geometry.size.height - 90)))
          .caloricGlass(in: RoundedRectangle(cornerRadius: 26)).glassIdentity("conversation", in: glassNamespace).padding(.horizontal, 12)
          .transition(.move(edge: .bottom))
        }
        composer
       }.padding(.bottom, 6)
       }
      }
            .onChange(of: store.userID, initial: true) { _, id in
                chat.reset(accountID: id); _ = voice.stop(cancelled: true)
                #if DEBUG
                if AppConfiguration.uiTesting, id != nil, ProcessInfo.processInfo.arguments.contains("-seed-chat") {
                    chat.messages = [
                        ChatMessage(kind: "text", role: "user", text: "What can I add for lunch?"),
                        ChatMessage(kind: "text", text: "Try a chicken bowl with rice and vegetables.")
                    ]
                    panelOpen = true
                }
                #endif
            }
            .onChange(of: inputFocused) { _, focused in if focused { withAnimation { panelOpen = true } } }
            .onChange(of: isPresented) { _, presented in if !presented { inputFocused = false; _ = voice.stop(cancelled: true) } }
            .onChange(of: scenePhase) { _, phase in chat.setForeground(phase == .active) }
            .onDisappear { _ = voice.stop(cancelled: true) }
    }
    @ViewBuilder private func messageView(_ message: ChatMessage) -> some View {
        switch message.kind {
        case "text":
            HStack {
                if message.role == "user" { Spacer(minLength: 36) }
                Text(message.role == "user" ? AttributedString(message.text) : (try? AttributedString(markdown: message.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(message.text))
                    .font(.system(size: 16)).textSelection(.enabled).padding(14)
                    .foregroundStyle(message.role == "user" ? Theme.onTint : Theme.label)
                    .background(message.role == "user" ? Theme.tint : Theme.input, in: RoundedRectangle(cornerRadius: 16))
                if message.role != "user" { Spacer(minLength: 16) }
            }
        case "audio":
            HStack {
                Spacer(minLength: 36)
                HStack(spacing: 12) {
                    Image(systemName: "mic.fill").frame(width: 36, height: 36).background(.white.opacity(0.15), in: Circle())
                    VStack(alignment: .leading, spacing: 3) { Text(message.text).font(.system(size: 15, weight: .semibold)); Text(message.duration ?? "0:00").font(.system(size: 12)).opacity(0.8) }
                    waveform(color: Theme.onTint)
                }.padding(14).foregroundStyle(Theme.onTint).background(Theme.tint, in: RoundedRectangle(cornerRadius: 16))
            }
        case "search":
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation { if expanded.contains(message.id) { expanded.remove(message.id) } else { expanded.insert(message.id) } }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "magnifyingglass")
                        (Text("Searched for ") + Text(message.query ?? message.foods.first?.name ?? "foods").bold()).frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: expanded.contains(message.id) ? "chevron.up" : "chevron.down")
                    }.font(.system(size: 13)).foregroundStyle(.secondary).padding(.vertical, 4)
                }.buttonStyle(.plain).accessibilityLabel(expanded.contains(message.id) ? "Hide search results" : "Show search results")
                if expanded.contains(message.id) {
                    ForEach(message.foods) { food in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(food.name).font(.system(size: 14, weight: .semibold))
                            Text([food.resultId, food.sourceLabel, food.brand, food.serving].compactMap { $0 }.joined(separator: " • ")).font(.system(size: 12)).foregroundStyle(.secondary)
                            MacroBadges(nutrition: food.nutrition)
                        }.padding(.vertical, 10)
                        if food.id != message.foods.last?.id { Divider() }
                    }
                }
            }.caloricCard().background(Theme.input, in: RoundedRectangle(cornerRadius: 16))
        case "approval":
            VStack(alignment: .leading, spacing: 12) {
                Text("Review suggestions").font(.system(size: 16, weight: .bold))
                ForEach(message.suggestions) { suggestion in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .top, spacing: 6) {
                            Text(suggestion.food.sourceLabel).font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary).padding(4).background(Theme.background, in: RoundedRectangle(cornerRadius: 5))
                            Text([suggestion.food.name, suggestion.food.brand].compactMap { $0 }.joined(separator: " • ")).font(.system(size: 15, weight: .semibold))
                        }
                        if let serving = suggestion.food.serving { Text(serving).font(.system(size: 12)).foregroundStyle(.secondary) }
                        Text("\(suggestion.resultId) • \(Portion.label(suggestion.portion)) to \(suggestion.meal.label)").font(.system(size: 12)).foregroundStyle(.secondary)
                        MacroBadges(nutrition: suggestion.food.nutrition, multiplier: suggestion.portion)
                        Text(suggestion.reason).font(.system(size: 13)).foregroundStyle(.secondary)
                        if let output = suggestion.output {
                            Text(output.approved ? "Approved and logged." : output.reason ?? "Rejected. Ask for another option.")
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(output.approved ? Color.green : Color.red)
                        } else {
                            HStack(spacing: 8) {
                                Button("Approve") { chat.approve(messageID: message.id, suggestionID: suggestion.id, approved: true, store: store) }
                                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.onTint).padding(.horizontal, 16).padding(.vertical, 9).background(Theme.tint, in: RoundedRectangle(cornerRadius: 9))
                                Button("Reject") { chat.approve(messageID: message.id, suggestionID: suggestion.id, approved: false, store: store) }
                                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.vertical, 9).background(Theme.background, in: RoundedRectangle(cornerRadius: 9))
                            }.disabled(chat.streaming).buttonStyle(.plain).padding(.top, 4)
                        }
                    }.caloricCard(padding: 12).overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.separator, lineWidth: 0.5))
                }
            }.caloricCard()
        default: EmptyView()
        }
    }
    private var composer: some View {
        VoiceComposer(input: $input, voice: voice, focus: $inputFocused, disabled: chat.streaming, sendText: sendText, sendVoice: { audio, duration in
            panelOpen = true
            chat.submit("", store: store, audio: audio, duration: duration)
        }, glassNamespace: glassNamespace)
    }
    private func waveform(color: Color) -> some View {
        HStack(spacing: 2) { ForEach(Array([8.0, 14, 10, 18, 12, 20, 9, 16, 11, 15].enumerated()), id: \.offset) { _, height in Capsule().fill(color).frame(width: 2, height: height) } }
    }
    private func sendText() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        panelOpen = true
        input = ""; inputFocused = false; chat.submit(text, store: store)
    }
}
