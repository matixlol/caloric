import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Host, Image, TextField, type TextFieldRef, useNativeState } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, disabled, glassEffect, padding, tint } from "@expo/ui/swift-ui/modifiers";
import { GlassView } from "expo-glass-effect";
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useThemedStyles } from "../theme/useAppTheme";
import { useAIChat } from "./AIChatProvider";
import {
  composerEnterTransition,
  composerExitTransition,
  composerLayoutTransition,
} from "./animations";
import {
  RecordingCancelHint,
  RecordingCardView,
  RecordingLockTarget,
  RecordingWaveform,
} from "./components";
import { createStyles } from "./styles";

// The composer "message bar" used inside the native bottom-accessory (the
// `regular`/expanded placement). It holds no state of its own — everything is
// read from AIChatProvider so the collapsed and expanded accessory copies stay
// in sync.
export function AIComposer() {
  const { palette, isDark, styles } = useThemedStyles(createStyles);
  const {
    setInput,
    hasInputText,
    canUseComposerActions,
    submitMessage,
    isRecording,
    isRecordingLocked,
    recordingSeconds,
    recordingUiProgress,
    recordingDragProgress,
    recordingCancelProgress,
    voiceButtonAnimatedStyle,
    handleVoicePressIn,
    handleVoiceRecordingMove,
    handleVoicePressOut,
    cancelVoiceRecording,
    sendVoiceRecording,
    formatRecordingDuration,
    openConversation,
    blurNonce,
  } = useAIChat();

  // Native observable state backing the @expo/ui TextField. Mirrored into the
  // provider's `input` via onTextChange so the send/mic toggle and submit work.
  const textState = useNativeState("");
  const fieldRef = useRef<TextFieldRef>(null);

  // When the conversation is closed, blur the input so it loses focus —
  // otherwise it stays focused and tapping it again won't re-fire focus to
  // reopen the panel. Skip the initial mount (blurNonce starts at 0).
  useEffect(() => {
    if (blurNonce > 0) {
      void fieldRef.current?.blur();
    }
  }, [blurNonce]);

  // A liquid-glass circle that sits behind a button's icon, so the action
  // buttons read as glassy pills rather than solid fills. Keyed by scheme:
  // re-assigning an already-mounted UIGlassEffect on appearance change renders
  // incorrectly (expo/expo#43732), so force a clean remount instead.
  const glassCircle = (
    <GlassView
      key={isDark ? "glass-dark" : "glass-light"}
      pointerEvents="none"
      glassEffectStyle="regular"
      colorScheme={isDark ? "dark" : "light"}
      style={glassButtonStyles.bg}
    />
  );

  return (
    <Animated.View layout={composerLayoutTransition} style={styles.composerRow}>
        {isRecording ? (
          <RecordingCardView
            progress={recordingUiProgress}
            style={[styles.recordingCard, isRecordingLocked && styles.recordingCardLocked]}
          >
            <View style={styles.recordingStatusRow}>
              <View style={styles.recordingLiveDot} />
              <Animated.Text style={styles.recordingTimer}>
                {formatRecordingDuration(recordingSeconds)}
              </Animated.Text>
            </View>
            <RecordingWaveform color={palette.error} />
            {isRecordingLocked ? null : (
              <RecordingCancelHint
                progress={recordingCancelProgress}
                palette={palette}
                styles={styles}
              />
            )}
          </RecordingCardView>
        ) : (
          <Animated.View
            entering={composerEnterTransition}
            exiting={composerExitTransition}
            layout={composerLayoutTransition}
            style={styles.inputBoxWrap}
          >
            <Host
              matchContents={{ vertical: true }}
              colorScheme={isDark ? "dark" : "light"}
              style={styles.inputHost}
            >
              <TextField
                ref={fieldRef}
                text={textState}
                placeholder="Message the food assistant"
                axis="vertical"
                maxLength={600}
                onTextChange={setInput}
                onFocusChange={(focused) => {
                  if (focused) {
                    openConversation();
                  }
                }}
                // Intentionally not disabled while streaming: the input stays
                // focusable so focusing it can reopen a closed conversation
                // panel. Sending is still gated inside submitMessage().
                modifiers={[
                  padding({ horizontal: 16, vertical: 10 }),
                  glassEffect({ glass: { variant: "regular" }, shape: "capsule" }),
                  tint(palette.tint),
                ]}
              />
            </Host>
          </Animated.View>
        )}

        {hasInputText && !isRecording ? (
          <Animated.View
            key="send"
            entering={composerEnterTransition}
            exiting={composerExitTransition}
            layout={composerLayoutTransition}
          >
            <Host matchContents style={glassButtonStyles.host}>
              <Button
                onPress={() => {
                  void submitMessage();
                  textState.value = "";
                }}
                modifiers={[
                  buttonStyle("glass"),
                  controlSize("large"),
                  tint(palette.tint),
                  disabled(!canUseComposerActions || !hasInputText),
                ]}
              >
                <Image systemName="arrow.up" size={20} color={palette.tint} />
              </Button>
            </Host>
          </Animated.View>
        ) : null}

        {isRecordingLocked ? (
          <Animated.View
            entering={composerEnterTransition}
            exiting={composerExitTransition}
            layout={composerLayoutTransition}
          >
            <Host matchContents style={glassButtonStyles.host}>
              <Button
                onPress={() => {
                  void cancelVoiceRecording();
                }}
                modifiers={[buttonStyle("glass"), controlSize("large"), tint("#8E8E93")]}
              >
                <Image systemName="trash" size={18} color="#8E8E93" />
              </Button>
            </Host>
          </Animated.View>
        ) : null}

        {isRecordingLocked ? (
          <Animated.View
            entering={composerEnterTransition}
            exiting={composerExitTransition}
            layout={composerLayoutTransition}
          >
            <Host matchContents style={glassButtonStyles.host}>
              <Button
                onPress={() => {
                  void sendVoiceRecording();
                }}
                modifiers={[buttonStyle("glassProminent"), controlSize("large"), tint(palette.tint)]}
              >
                <Image systemName="arrow.up" size={20} color="#FFFFFF" />
              </Button>
            </Host>
          </Animated.View>
        ) : null}

        {!hasInputText && !isRecordingLocked ? (
          <Animated.View
            entering={composerEnterTransition}
            exiting={composerExitTransition}
            layout={composerLayoutTransition}
            style={styles.voiceActionWrap}
          >
            {isRecording ? (
              <RecordingLockTarget
                progress={recordingDragProgress}
                locked={isRecordingLocked}
                palette={palette}
                styles={styles}
              />
            ) : null}
            <Animated.View
              key="voice"
              accessible
              accessibilityLabel={isRecording ? "Drag up to hold recording" : "Hold to record voice note"}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canUseComposerActions }}
              onResponderGrant={handleVoicePressIn}
              onResponderMove={handleVoiceRecordingMove}
              onResponderRelease={handleVoicePressOut}
              onResponderTerminate={handleVoicePressOut}
              onStartShouldSetResponder={() => canUseComposerActions}
              style={[
                styles.voiceButton,
                isRecording && styles.voiceButtonRecording,
                voiceButtonAnimatedStyle as never,
              ]}
            >
              {glassCircle}
              {/* Disabled dim goes on the icon, never on the wrapper: opacity
                  on the glass circle's ancestors kills the glass effect. */}
              <Ionicons
                name={isRecording ? "lock-open" : "mic"}
                size={isRecording ? 22 : 24}
                color={isRecording ? palette.error : palette.tint}
                style={canUseComposerActions ? undefined : styles.buttonDisabled}
              />
            </Animated.View>
          </Animated.View>
        ) : null}
      </Animated.View>
  );
}

const glassButtonStyles = StyleSheet.create({
  bg: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 22,
    overflow: "hidden",
  },
  host: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
