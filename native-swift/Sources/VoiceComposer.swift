import SwiftUI

struct VoiceComposer: View {
    @Binding var input: String
    @Bindable var voice: VoiceRecorder
    var focus: FocusState<Bool>.Binding
    let disabled: Bool
    let sendText: () -> Void
    let sendVoice: (URL, String) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var holding = false
    @State private var locked = false
    @State private var lockProgress: CGFloat = 0
    @State private var cancelProgress: CGFloat = 0
    private var active: Bool { voice.recording || voice.starting }
    private var cancelling: Bool { cancelProgress >= 1 && !locked }

    var body: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                if active { recordingCard.transition(.opacity.combined(with: .move(edge: .bottom))) }
                else {
                    TextField("Message the food assistant", text: $input, axis: .vertical)
                        .lineLimit(1...5).font(.system(size: 16)).focused(focus).disabled(disabled)
                        .padding(.horizontal, 14).padding(.vertical, 12).background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
                        .accessibilityIdentifier("ai-composer")
                        .onChange(of: input) { _, value in if value.count > 600 { input = String(value.prefix(600)) } }
                }
                if !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !active {
                    actionButton("paperplane.fill", label: "Send message", color: Theme.tint, action: sendText).disabled(disabled)
                } else if locked && voice.recording {
                    actionButton("paperplane.fill", label: "Send voice message", color: Theme.tint) { finish(cancelled: false) }
                } else { microphone }
            }
            if let error = voice.error {
                Text(error).font(.system(size: 12)).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(.horizontal, 12).padding(.vertical, 6)
            .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.86), value: active)
            .animation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.8), value: locked)
            .onChange(of: voice.recording) { _, recording in
                if recording { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
                else if !voice.starting { reset() }
            }
            .onChange(of: scenePhase) { _, phase in if phase != .active { finish(cancelled: true) } }
            .onDisappear { finish(cancelled: true) }
    }

    private var recordingCard: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                if voice.starting { ProgressView().controlSize(.small) }
                else {
                    TimelineView(.animation(minimumInterval: 0.05, paused: reduceMotion)) { context in
                        Circle().fill(cancelling ? Color.secondary : Color.red).frame(width: 8, height: 8)
                            .opacity(reduceMotion ? 1 : 0.55 + 0.45 * abs(sin(context.date.timeIntervalSinceReferenceDate * 3)))
                    }.frame(width: 8, height: 8).accessibilityHidden(true)
                }
                Text(voice.starting ? "Preparing microphone…" : cancelling ? "Cancelling" : locked ? "Recording locked" : "Recording")
                    .font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 0)
                Text(voice.duration).font(.system(size: 14, weight: .semibold)).monospacedDigit()
                    .accessibilityLabel("Recording duration \(voice.duration)")
            }
            HStack(spacing: 3) {
                ForEach(voice.levels.indices, id: \.self) { index in
                    Capsule().fill(cancelling ? Color.secondary : Theme.tint)
                        .frame(maxWidth: .infinity).frame(height: 5 + voice.levels[index] * 27)
                }
            }.frame(height: 32).animation(reduceMotion ? nil : .linear(duration: 0.065), value: voice.levels).accessibilityHidden(true)
            if locked {
                HStack {
                    Button { finish(cancelled: true) } label: { Label("Discard", systemImage: "trash") }
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.red).accessibilityLabel("Cancel voice recording")
                    Spacer()
                }.frame(minHeight: 24)
            } else {
                HStack(spacing: 4) {
                    Image(systemName: cancelling ? "trash" : "chevron.left")
                    Spacer(minLength: 0)
                }.font(.system(size: 12)).foregroundStyle(cancelling ? Color.red : Color.secondary)
                    .offset(x: -min(cancelProgress, 1) * 8).frame(minHeight: 24)
            }
        }.padding(12).frame(maxWidth: .infinity)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(cancelling ? Color.red.opacity(0.5) : Theme.tint.opacity(0.18), lineWidth: 1))
            .accessibilityIdentifier("voice-recording-card")
    }

    private var microphone: some View {
        Image(systemName: active ? "mic.fill" : "mic").font(.system(size: 22))
            .frame(width: 48, height: 48).foregroundStyle(active ? .white : .primary)
            .background(active ? Color.red : Theme.card, in: Circle())
            .overlay(Circle().stroke(Color.red.opacity(active ? 0.18 : 0), lineWidth: active ? 8 : 0))
            .scaleEffect(active && !reduceMotion ? 1.06 : 1)
            .offset(x: active ? -min(cancelProgress, 1) * 14 : 0, y: active ? -min(lockProgress, 1) * 8 : 0)
            .overlay(alignment: .bottom) {
                if active && !locked {
                    VStack(spacing: 4) {
                        Image(systemName: "lock.open.fill").font(.system(size: 16))
                        ZStack(alignment: .bottom) {
                            Capsule().fill(Color.secondary.opacity(0.15)).frame(width: 4, height: 26)
                            Capsule().fill(.red).frame(width: 4, height: max(3, 26 * lockProgress))
                        }
                        Image(systemName: "chevron.up").font(.system(size: 11, weight: .bold))
                    }.foregroundStyle(.red).frame(width: 54).padding(.vertical, 8)
                        .background(.regularMaterial, in: Capsule()).offset(y: -68).allowsHitTesting(false)
                        .transition(.opacity.combined(with: .scale)).accessibilityHidden(true)
                }
            }
            .contentShape(Circle()).gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { gesture in
                    guard !disabled, !locked else { return }
                    if !holding {
                        holding = true; focus.wrappedValue = false; cancelProgress = 0; lockProgress = 0
                        Task { guard holding else { return }; await voice.start() }
                    }
                    guard voice.recording else { return }
                    cancelProgress = min(1, max(0, -gesture.translation.width / 82))
                    lockProgress = min(1, max(0, -gesture.translation.height / 54))
                    if lockProgress >= 1 && cancelProgress < 1 {
                        locked = true; holding = false; cancelProgress = 0
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    }
                }
                .onEnded { _ in holding = false; if !locked { finish(cancelled: cancelling) } })
            .accessibilityLabel("Record voice message").accessibilityIdentifier("voice-microphone")
            .accessibilityHint("Hold to record. Release to send. Slide up to lock or left to cancel.")
            .accessibilityAddTraits(.isButton).accessibilityAction {
                guard !disabled else { return }
                focus.wrappedValue = false
                Task { await voice.start(); if voice.recording { locked = true } }
            }.opacity(disabled ? 0.5 : 1)
    }

    private func actionButton(_ image: String, label: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: image).font(.system(size: 20)).frame(width: 48, height: 48).foregroundStyle(.white).background(color, in: Circle()) }
            .accessibilityLabel(label)
    }

    private func finish(cancelled: Bool) {
        let duration = voice.duration
        if let audio = voice.stop(cancelled: cancelled) { sendVoice(audio, duration) }
        reset()
    }
    private func reset() { holding = false; locked = false; cancelProgress = 0; lockProgress = 0 }
}
