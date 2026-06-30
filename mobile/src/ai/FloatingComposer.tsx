import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAIChat } from "./AIChatProvider";
import { AIComposer } from "./AIComposer";

// Approximate resting height of the composer bar; used by the conversation
// panel to anchor itself just above the bar.
export const COMPOSER_BAR_HEIGHT = 56;

// The persistent message box, floating at the bottom of the screen. The input
// pill and voice button float on their own — there is no container background.
// Rises above the keyboard when it is shown.
export function FloatingComposer() {
  const insets = useSafeAreaInsets();
  const { isKeyboardVisible, keyboardHeight } = useAIChat();

  const bottom = isKeyboardVisible ? keyboardHeight + 6 : insets.bottom + 6;

  return (
    <View pointerEvents="box-none" style={[styles.container, { bottom }]}>
      <AIComposer />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 12,
    right: 12,
    // overflow visible so the recording lock/cancel affordance can pop above
    // the bar while holding the voice button.
    overflow: "visible",
  },
});
