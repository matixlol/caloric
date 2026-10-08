import { bentoColor } from "./brandPalette";

export const macroColors = {
  protein: {
    background: "#2563EB",
    text: "#FFFFFF",
  },
  carbs: {
    background: "#F59E0B",
    text: "#1F2937",
  },
  fat: {
    background: "#14B8A6",
    text: "#FFFFFF",
  },
  calories: {
    background: bentoColor("tertiarySystemGroupedBackground", "#E3D6C2"),
    text: bentoColor("label", "#22231D"),
  },
} as const;
