const IS_DEV_APP = process.env.APP_VARIANT === "development";

const bundleIdentifier = IS_DEV_APP ? "lol.mati.caloric.dev" : "lol.mati.caloric";
const appName = IS_DEV_APP ? "Caloric Dev" : "caloric";
const scheme = IS_DEV_APP ? "caloric-dev" : "caloric";
const iCloudContainer = `iCloud.${bundleIdentifier}`;
const appGroup = `group.${bundleIdentifier}`;

module.exports = {
  expo: {
    name: appName,
    slug: "caloric",
    version: "1.0.0",
    runtimeVersion: {
      policy: "fingerprint",
    },
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme,
    userInterfaceStyle: "automatic",
    updates: {
      url: "https://u.expo.dev/7e5b3130-5a61-430b-ba37-1958e9248b32",
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 0,
      useEmbeddedUpdate: true,
      enableBsdiffPatchSupport: true,
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier,
      entitlements: {
        "com.apple.security.application-groups": [appGroup],
      },
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSMicrophoneUsageDescription: "Caloric uses your microphone so you can log food with voice.",
        LSSupportsOpeningDocumentsInPlace: true,
        NSUbiquitousContainers: {
          [iCloudContainer]: {
            NSUbiquitousContainerIsDocumentScopePublic: true,
            NSUbiquitousContainerName: appName,
            NSUbiquitousContainerSupportedFolderLevels: "Any",
          },
        },
      },
    },
    android: {
      package: bundleIdentifier,
      permissions: ["RECORD_AUDIO"],
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
    },
    web: {
      output: "static",
      favicon: "./assets/images/favicon.png",
    },
    plugins: [
      "expo-router",
      [
        "expo-build-properties",
        {
          // Clerk's transitive Google pods (AppCheckCore/GoogleUtilities/
          // RecaptchaInterop) can't link as static libraries without modules.
          // Static frameworks resolves it; verified the app + widget build
          // and run under this linkage.
          ios: {
            useFrameworks: "static",
          },
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          dark: {
            backgroundColor: "#000000",
          },
        },
      ],
      "expo-secure-store",
      [
        "expo-audio",
        {
          enableBackgroundPlayback: false,
        },
      ],
      "./plugins/withThirdPartySQLitePod",
      "./plugins/withICloudBackup",
      [
        "@clerk/expo",
        {
          appleSignIn: false,
        },
      ],
      "expo-asset",
      "expo-font",
      "expo-image",
      "expo-web-browser",
      [
        "@sentry/react-native/expo",
        {
          url: "https://sentry.io/",
          project: "caloric-mobile",
          organization: "matiinc",
        },
      ],
      "@bacons/apple-targets",
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: {},
      appGroup,
      eas: {
        projectId: "7e5b3130-5a61-430b-ba37-1958e9248b32",
      },
    },
  },
};
