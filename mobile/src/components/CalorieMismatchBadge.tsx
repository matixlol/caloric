import Ionicons from "@expo/vector-icons/Ionicons";
import { StyleSheet, Text, View } from "react-native";

export function CalorieMismatchBadge() {
  return (
    <View
      accessibilityLabel="Calories and macros differ by more than 8 percent"
      style={styles.badge}
    >
      <Ionicons color="#92400E" name="alert-circle" size={12} />
      <Text style={styles.text}>Macro mismatch</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    alignItems: "center",
    backgroundColor: "#FEF3C7",
    borderRadius: 7,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  text: {
    color: "#92400E",
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 14,
  },
});
