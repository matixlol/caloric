import { Button, HStack, Host, TextField, type TextFieldRef } from "@expo/ui/swift-ui";
import {
  autocorrectionDisabled,
  buttonStyle,
  controlSize,
  disabled,
  frame,
  keyboardType as swiftKeyboardType,
  submitLabel,
  textFieldStyle,
  textInputAutocapitalization,
} from "@expo/ui/swift-ui/modifiers";
import { useCallback, useRef } from "react";
import { StyleSheet } from "react-native";

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
  const inputRef = useRef<TextFieldRef>(null);
  const handleValueChange = useCallback(
    (value: string) => {
      const normalized = (props.normalizeText?.(value) ?? value).slice(0, props.maxLength);
      if (normalized !== value) {
        void inputRef.current?.setText(normalized);
      }

      props.onChangeText(normalized);
    },
    [props],
  );

  return (
    <Host matchContents={{ vertical: true }} style={styles.host}>
      <HStack alignment="center" spacing={8}>
        <TextField
          ref={inputRef}
          defaultValue={props.defaultValue}
          placeholder={props.placeholder}
          onValueChange={handleValueChange}
          modifiers={[
            frame({ minWidth: 132 }),
            textFieldStyle("roundedBorder"),
            controlSize("regular"),
            autocorrectionDisabled(props.autoCorrect === false),
            textInputAutocapitalization(props.autoCapitalize === "none" ? "never" : (props.autoCapitalize ?? "sentences")),
            submitLabel("done"),
            ...(props.keyboardType === "numeric" ? [swiftKeyboardType("numeric")] : []),
          ]}
        />
        <Button
          label={props.actionLabel}
          onPress={props.onActionPress}
          modifiers={[
            buttonStyle("bordered"),
            controlSize("regular"),
            disabled(props.actionDisabled),
          ]}
        />
      </HStack>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
    minHeight: 38,
  },
});
