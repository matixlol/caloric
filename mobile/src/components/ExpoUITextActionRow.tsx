import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useAppTheme } from "../theme/useAppTheme";

export type ExpoUITextActionRowProps = {
  defaultValue: string;
  placeholder: string;
  maxLength?: number;
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
  autoCorrect?: boolean;
  keyboardType?: "default" | "numeric";
  normalizeText?: (value: string) => string;
  onChangeText: (value: string) => void;
  actionLabel: string;
  actionAccessibilityLabel: string;
  actionDisabled?: boolean;
  onActionPress: () => void;
};

export function ExpoUITextActionRow(props: ExpoUITextActionRowProps) {
  const { palette } = useAppTheme();

  return (
    <View style={styles.row}>
      <TextInput
        defaultValue={props.defaultValue}
        onChangeText={(value) => {
          const normalized = (props.normalizeText?.(value) ?? value).slice(0, props.maxLength);
          props.onChangeText(normalized);
        }}
        autoCapitalize={props.autoCapitalize}
        autoCorrect={props.autoCorrect}
        accessibilityLabel={props.placeholder}
        inputMode={props.keyboardType === "numeric" ? "numeric" : "text"}
        keyboardType={props.keyboardType === "numeric" ? "number-pad" : "default"}
        placeholder={props.placeholder}
        placeholderTextColor={palette.tertiaryLabel}
        maxLength={props.maxLength}
        style={[
          styles.input,
          {
            backgroundColor: palette.inputBackground,
            borderColor: palette.separator,
            color: palette.label,
          },
        ]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.actionAccessibilityLabel}
        disabled={props.actionDisabled}
        onPress={props.onActionPress}
        style={[
          styles.button,
          {
            backgroundColor: props.actionDisabled ? palette.tintDisabled : palette.tint,
          },
        ]}
      >
        <Text
          style={[
            styles.buttonText,
            { color: props.actionDisabled ? palette.buttonDisabledText : palette.buttonText },
          ]}
        >
          {props.actionLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 38,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 16,
    lineHeight: 20,
  },
  button: {
    minHeight: 38,
    borderRadius: 8,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: "700",
  },
});
