/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "CaloricWidget",
  displayName: "Caloric",
  // Appended to the app's bundle id -> "<appBundleId>.CaloricWidget".
  // The Swift code derives the App Group from this suffix, so keep them in sync.
  bundleIdentifier: ".CaloricWidget",
  // Lock-screen accessory families require iOS 16+.
  deploymentTarget: "16.1",
  frameworks: ["SwiftUI", "WidgetKit"],
  entitlements: {
    // Share the same App Group as the main app so the widget can read the
    // "todaySummary" snapshot the JS app writes via ExtensionStorage.
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
  },
});
