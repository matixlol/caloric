// Regenerate shipped branding from the approved SVG and shared palette.
// Run from the repository root: node mobile/scripts/generate-brand-assets.js
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const root = path.resolve(__dirname, "../..");

async function write(relative, value) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function main() {
  const palette = JSON.parse(await fs.readFile(path.join(root, "design/brand/palette.json"), "utf8"));
  const svg = await fs.readFile(path.join(root, "design/brand", palette.selectedIcon), "utf8");
  const full = await sharp(Buffer.from(svg)).resize(1024, 1024).flatten({ background: palette.ink }).png().toBuffer();
  await write("native-swift/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png", full);
  await write("mobile/assets/images/icon.png", full);
  await write("mobile/assets/images/favicon.png", await sharp(full).resize(64, 64).png().toBuffer());
  await write("mobile/assets/images/splash-icon.png", full);
  // Android adaptive foregrounds need room for launcher masks and motion.
  const body = svg.replace(/^.*?<rect width="1024" height="1024" fill="#[A-Fa-f0-9]+"\/>/s, "").replace(/<\/svg>\s*$/, "");
  const adaptive = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><g transform="translate(171.36 171.36) scale(.72)">${body}</g></svg>`;
  await write("mobile/assets/images/android-icon-foreground.png", await sharp(Buffer.from(adaptive)).png().toBuffer());
  await write("mobile/assets/images/android-icon-background.png", await sharp({ create: { width: 1080, height: 1080, channels: 3, background: palette.ink } }).png().toBuffer());
  const monochrome = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><g transform="translate(171.36 171.36) scale(.72)"><rect x="135" y="135" width="754" height="754" rx="122" fill="none" stroke="black" stroke-width="40"/><rect x="199" y="199" width="626" height="191" rx="35"/><rect x="199" y="417" width="191" height="191" rx="35"/><rect x="199" y="635" width="626" height="191" rx="35"/><rect x="440" y="440" width="143" height="143" rx="28"/><rect x="649" y="440" width="143" height="143" rx="28"/></g></svg>`;
  await write("mobile/assets/images/android-icon-monochrome.png", await sharp(Buffer.from(monochrome)).png().toBuffer());

  const swiftColor = hex => {
    const value = hex.slice(1);
    const components = [0, 2, 4].map(i => (parseInt(value.slice(i, i + 2), 16) / 255).toFixed(6));
    return `UIColor(red: ${components[0]}, green: ${components[1]}, blue: ${components[2]}, alpha: 1)`;
  };
  const names = ["background", "card", "inputBackground", "label", "secondaryLabel", "separator", "tint", "buttonText"];
  const nativeRoles = { background: "systemGroupedBackground", card: "secondarySystemGroupedBackground", inputBackground: "tertiarySystemGroupedBackground", label: "label", secondaryLabel: "secondaryLabel", separator: "separator" };
  const swift = `// Generated from design/brand/palette.json by generate-brand-assets.js.\nimport SwiftUI\nimport UIKit\n\nenum BrandPalette {\n    static let accent = Color(uiColor: ${swiftColor(palette.accent)})\n    static let ink = Color(uiColor: ${swiftColor(palette.ink)})\n${names.map(name => nativeRoles[name] ? `    static let ${name} = Color(uiColor: .${nativeRoles[name]})` : `    static let ${name} = Color(uiColor: UIColor { traits in\n        traits.userInterfaceStyle == .dark ? ${swiftColor(palette.dark[name])} : ${swiftColor(palette.light[name])}\n    })`).join("\n")}\n}\n`;
  await write("native-swift/Sources/BrandPalette.swift", swift);
  await write("mobile/targets/widget/BrandPalette.swift", swift);

  const assetColor = hex => ({ "color-space": "srgb", components: { red: `0x${hex.slice(1,3)}`, green: `0x${hex.slice(3,5)}`, blue: `0x${hex.slice(5,7)}`, alpha: "1.000" } });
  await write("native-swift/Resources/Assets.xcassets/AccentColor.colorset/Contents.json", JSON.stringify({ colors: [
    { idiom: "universal", color: assetColor(palette.light.tint) },
    { idiom: "universal", appearances: [{ appearance: "luminosity", value: "dark" }], color: assetColor(palette.dark.tint) },
  ], info: { author: "xcode", version: 1 } }, null, 2) + "\n");

  const ts = `// Generated from design/brand/palette.json by generate-brand-assets.js.\nimport { Appearance, DynamicColorIOS, Platform, PlatformColor } from "react-native";\n\nexport const brandPalettes = ${JSON.stringify({light:palette.light,dark:palette.dark},null,2)} as const;\nexport const brandAccent = "${palette.accent}";\nexport const brandInk = "${palette.ink}";\nexport const getBrandPalette = (isDark: boolean) => brandPalettes[isDark ? "dark" : "light"];\n\nconst roles: Record<string, keyof typeof brandPalettes.light> = {\n  systemGroupedBackground: "background", secondarySystemGroupedBackground: "card",\n  systemBackground: "cardElevated", secondarySystemBackground: "inputBackground",\n  tertiarySystemGroupedBackground: "inputBackground", label: "label",\n  secondaryLabel: "secondaryLabel", tertiaryLabel: "tertiaryLabel",\n  separator: "separator", systemBlue: "tint", tertiarySystemFill: "tintDisabled",\n  secondarySystemFill: "assistantBubble", quaternarySystemFill: "inputBackground",\n};\nexport function bentoColor(name: string, fallback: string, isDark?: boolean) {\n  const role = roles[name];\n  if (Platform.OS === "ios" && name !== "systemBlue") return PlatformColor(name);\n  if (!role) return Platform.OS === "ios" ? PlatformColor(name) : fallback;\n  if (isDark === undefined && Platform.OS === "ios") {\n    return DynamicColorIOS({ light: brandPalettes.light[role], dark: brandPalettes.dark[role] });\n  }\n  return getBrandPalette(isDark ?? Appearance.getColorScheme() === "dark")[role];\n}\n`;
  await write("mobile/src/theme/brandPalette.ts", ts);
  console.log("Generated Bento icons and shared light/dark brand colors.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
