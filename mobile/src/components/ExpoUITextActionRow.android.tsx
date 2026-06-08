import { Host, OutlinedTextField, Row, Text, TextButton, type TextFieldRef } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, height, weight } from "@expo/ui/jetpack-compose/modifiers";
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
      <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: 8 }} modifiers={[fillMaxWidth()]}>
        <OutlinedTextField
          ref={inputRef}
          defaultValue={props.defaultValue}
          onValueChange={handleValueChange}
          singleLine
          keyboardOptions={{
            capitalization: props.autoCapitalize === "none" ? "none" : (props.autoCapitalize ?? "sentences"),
            autoCorrectEnabled: props.autoCorrect !== false,
            keyboardType: props.keyboardType === "numeric" ? "number" : "text",
            imeAction: "done",
          }}
          modifiers={[weight(1), height(48)]}
        >
          <OutlinedTextField.Placeholder>
            <Text>{props.placeholder}</Text>
          </OutlinedTextField.Placeholder>
        </OutlinedTextField>
        <TextButton enabled={!props.actionDisabled} onClick={props.onActionPress}>
          <Text>{props.actionLabel}</Text>
        </TextButton>
      </Row>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
    minHeight: 48,
  },
});
