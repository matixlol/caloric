import SwiftUI

/// Owns the assistant's conversation and recorder for the signed-in account.
struct AILogView: View {
    var isPresented = true
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var chat = AILogService()
    @State private var voice = VoiceRecorder()
    var body: some View {
        AssistantView(chat: chat, voice: voice, isPresented: isPresented)
            .onChange(of: store.userID, initial: true) { _, id in
                chat.reset(accountID: id); _ = voice.stop(cancelled: true)
                #if DEBUG
                if AppConfiguration.uiTesting, id != nil, ProcessInfo.processInfo.arguments.contains("-seed-chat") {
                    chat.messages = AssistantDemo.conversation()
                }
                if AppConfiguration.uiTesting, id != nil, ProcessInfo.processInfo.arguments.contains("-seed-chat-activity") {
                    chat.simulateStreaming(AssistantDemo.activity())
                }
                #endif
            }
            .onChange(of: isPresented) { _, presented in if !presented { _ = voice.stop(cancelled: true) } }
            .onChange(of: scenePhase) { _, phase in chat.setForeground(phase == .active) }
            .onDisappear { _ = voice.stop(cancelled: true) }
    }
}
