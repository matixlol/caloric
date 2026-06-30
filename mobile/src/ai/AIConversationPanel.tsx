import Ionicons from "@expo/vector-icons/Ionicons";
import { GlassView } from "expo-glass-effect";
import { useEffect, useRef } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StreamdownRN } from "streamdown-rn";
import { MacroBadges } from "../components/MacroBadges";
import { mealLabelFor } from "../meals";
import { formatPortionLabel } from "../portion";
import { useThemedStyles } from "../theme/useAppTheme";
import { useAIChat } from "./AIChatProvider";
import { searchLayoutTransition } from "./animations";
import { AudioBubbleWaveform, SearchResultsDisclosure, TypingIndicator } from "./components";
import { COMPOSER_BAR_HEIGHT } from "./FloatingComposer";
import { inferSearchQueryFromFoods } from "./helpers";
import { createStyles } from "./styles";

// The AI conversation transcript, rendered as an inline overlay anchored to the
// bottom of the Today screen, just above the native tab bar + composer
// accessory. It holds no state — everything comes from AIChatProvider.
export function AIConversationPanel() {
  const { palette, markdownTheme, isDark, styles } = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const scrollViewRef = useRef<ScrollView | null>(null);
  const {
    messages,
    status,
    isStreaming,
    error,
    errorDetails,
    expandedSearchIds,
    toggleSearchExpanded,
    respondToApproval,
    isConversationVisible,
    isKeyboardVisible,
    keyboardHeight,
    closeConversation,
  } = useAIChat();

  useEffect(() => {
    if (!isConversationVisible) {
      return;
    }
    requestAnimationFrame(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length, status, isConversationVisible]);

  // Render whenever the transcript is showing, or whenever the keyboard is up
  // (so the dismiss scrim exists even before the first message is sent).
  if (!isConversationVisible && !isKeyboardVisible) {
    return null;
  }

  // Sit just above the floating composer bar; ride above the keyboard when it
  // is up so the transcript isn't hidden behind it.
  const composerBase = isKeyboardVisible ? keyboardHeight + 6 : insets.bottom + 6;
  const bottomOffset = composerBase + COMPOSER_BAR_HEIGHT + 8;

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
      pointerEvents="box-none"
      style={[panelStyles.container, { bottom: bottomOffset, top: insets.top + 8 }]}
    >
      {isKeyboardVisible ? (
        // Tap the area above the transcript to dismiss the keyboard. Keyboard
        // dismiss resigns first responder so the bar can be focused again.
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => Keyboard.dismiss()}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {isConversationVisible ? (
      <GlassView
        glassEffectStyle="regular"
        colorScheme={isDark ? "dark" : "light"}
        style={panelStyles.card}
      >
        <View style={panelStyles.headerRow}>
          <View style={panelStyles.headerTitleRow}>
            <Ionicons name="sparkles" size={15} color={palette.tint} />
            <Text style={panelStyles.headerTitle}>Food assistant</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hide the food assistant conversation"
            onPress={closeConversation}
            hitSlop={10}
            style={panelStyles.closeButton}
          >
            <Ionicons name="chevron-down" size={18} color={palette.secondaryLabel} />
          </Pressable>
        </View>

        <ScrollView
          ref={scrollViewRef}
          style={panelStyles.scroll}
          contentContainerStyle={panelStyles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onContentSizeChange={() => {
            scrollViewRef.current?.scrollToEnd({ animated: true });
          }}
        >
          {messages.map((message) => {
            const isLastMessage = messages[messages.length - 1]?.id === message.id;
            const isActiveAssistantStream =
              message.kind === "text" && message.role === "assistant" && isStreaming && isLastMessage;

            if (message.kind === "text") {
              const isUser = message.role === "user";
              const text = message.text.trim();

              return (
                <View
                  key={message.id}
                  style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}
                >
                  {text ? (
                    isUser ? (
                      <Text style={[styles.messageText, styles.userMessageText]}>{message.text}</Text>
                    ) : (
                      <StreamdownRN
                        theme={markdownTheme}
                        isComplete={!isActiveAssistantStream}
                        style={styles.assistantMarkdown}
                      >
                        {message.text}
                      </StreamdownRN>
                    )
                  ) : (
                    <TypingIndicator color={palette.secondaryLabel} />
                  )}
                </View>
              );
            }

            if (message.kind === "audio") {
              return (
                <View
                  key={message.id}
                  style={[styles.messageBubble, styles.userBubble, styles.audioBubble]}
                >
                  <View style={styles.audioIconCircle}>
                    <Ionicons name="mic" size={15} color={palette.userBubble} />
                  </View>
                  <AudioBubbleWaveform color={palette.buttonText} />
                  <View style={styles.audioMetaColumn}>
                    <Text style={[styles.audioLabel, styles.userMessageText]}>{message.label}</Text>
                    <Text style={styles.audioDuration}>{message.durationLabel}</Text>
                  </View>
                </View>
              );
            }

            if (message.kind === "search") {
              if (message.foods.length === 0) {
                return null;
              }

              const isExpanded = expandedSearchIds.has(message.id);
              const query = message.query?.trim() || inferSearchQueryFromFoods(message.foods);

              return (
                <Animated.View
                  key={message.id}
                  layout={searchLayoutTransition}
                  style={[styles.messageBubble, styles.assistantBubble, styles.searchBubble]}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={isExpanded ? "Hide search results" : "Show search results"}
                    onPress={() => {
                      toggleSearchExpanded(message.id);
                    }}
                    style={styles.searchSummaryRow}
                  >
                    <Ionicons name="search" size={15} color={palette.secondaryLabel} />
                    <Text style={styles.searchSummaryText}>
                      Searched for <Text style={styles.searchSummaryQuery}>{query}</Text>
                    </Text>
                    <Ionicons
                      name={isExpanded ? "chevron-up" : "chevron-down"}
                      size={15}
                      color={palette.secondaryLabel}
                    />
                  </Pressable>

                  <SearchResultsDisclosure expanded={isExpanded} foods={message.foods} styles={styles} />
                </Animated.View>
              );
            }

            return (
              <View key={message.id} style={[styles.messageBubble, styles.assistantBubble, styles.approvalBubble]}>
                <View style={styles.toolCard}>
                  <Text style={styles.toolHeading}>Review suggestions</Text>
                  {message.suggestions.map((suggestion) => {
                    const mealLabel = mealLabelFor(suggestion.meal);

                    return (
                      <View key={suggestion.suggestionId} style={styles.suggestionCard}>
                        <View style={styles.toolTitleRow}>
                          <Text style={styles.sourceBadge}>{suggestion.food.sourceLabel}</Text>
                          <Text style={styles.toolText}>
                            {suggestion.food.name}
                            {suggestion.food.brand ? ` • ${suggestion.food.brand}` : ""}
                          </Text>
                        </View>
                        {suggestion.food.serving ? (
                          <Text style={styles.toolMeta}>{suggestion.food.serving}</Text>
                        ) : null}
                        <Text style={styles.toolMeta}>
                          {suggestion.resultId} • {formatPortionLabel(suggestion.portion)} to {mealLabel}
                        </Text>
                        <MacroBadges
                          nutrition={suggestion.food.nutrition}
                          multiplier={suggestion.portion}
                          containerStyle={styles.toolMacroBadges}
                        />
                        <Text style={styles.toolReason}>{suggestion.reason}</Text>

                        {suggestion.output ? (
                          <Text
                            style={[
                              styles.toolMeta,
                              suggestion.output.approved ? styles.approvedText : styles.rejectedText,
                            ]}
                          >
                            {suggestion.output.approved
                              ? "Approved and logged."
                              : suggestion.output.reason ?? "Rejected. Ask for another option."}
                          </Text>
                        ) : (
                          <View style={styles.approvalRow}>
                            <Pressable
                              accessibilityRole="button"
                              disabled={isStreaming}
                              onPress={() => {
                                void respondToApproval(message.toolCallId, suggestion.suggestionId, true);
                              }}
                              style={[styles.approveButton, isStreaming && styles.buttonDisabled]}
                            >
                              <Text style={styles.approveButtonText}>Approve</Text>
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              disabled={isStreaming}
                              onPress={() => {
                                void respondToApproval(message.toolCallId, suggestion.suggestionId, false);
                              }}
                              style={[styles.denyButton, isStreaming && styles.buttonDisabled]}
                            >
                              <Text style={styles.denyButtonText}>Reject</Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              </View>
            );
          })}

          {isStreaming && (messages.length === 0 || (() => { const last = messages[messages.length - 1]; return !last || last.kind !== "text" || last.role !== "assistant"; })()) ? (
            <View style={[styles.messageBubble, styles.assistantBubble]}>
              <TypingIndicator color={palette.secondaryLabel} />
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
              {errorDetails ? (
                <Text selectable style={styles.errorDetailsText}>
                  {errorDetails}
                </Text>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </GlassView>
      ) : null}
    </Animated.View>
  );
}

const panelStyles = {
  container: {
    position: "absolute" as const,
    left: 10,
    right: 10,
    justifyContent: "flex-end" as const,
  },
  card: {
    flexShrink: 1,
    overflow: "hidden" as const,
    borderRadius: 22,
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  headerRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    paddingHorizontal: 6,
    paddingBottom: 6,
  },
  headerTitleRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: "600" as const,
    color: "rgba(127,127,127,0.95)",
  },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    paddingBottom: 4,
  },
};
