import { AuthView } from "@clerk/expo/native";
import { useAuth } from "@clerk/expo";
import { type ReactNode, useEffect } from "react";
import {
  ActivityIndicator,
  Platform,
  PlatformColor,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLastKnownUserId } from "../data/DataProvider";

type ClerkAuthGateProps = {
  children: ReactNode;
};

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

export function ClerkAuthGate({ children }: ClerkAuthGateProps) {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const lastKnownUserId = useLastKnownUserId();

  useEffect(() => {
    // Native Clerk views synchronize the session asynchronously with the JS SDK.
  }, [isSignedIn]);

  // Offline-first: until Clerk finishes its network-dependent load, optimistically
  // render the app for whoever was signed in last time so the cached UI opens
  // instantly (and works with no connectivity). Clerk corrects this once it loads:
  // a resolved signed-out state below falls through to the sign-in view.
  if (!isLoaded) {
    if (lastKnownUserId) {
      return <>{children}</>;
    }

    // Genuine cold start with no cached session — wait for Clerk.
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={iosColor("systemBlue", "#2563EB")} />
      </View>
    );
  }

  if (!isSignedIn) {
    return (
      <View style={styles.authContainer}>
        <View style={styles.authCard}>
          <Text style={styles.authTitle}>Caloric</Text>
          <Text style={styles.authSubtitle}>Sign in or create an account to continue.</Text>
          <View style={styles.authView}>
            <AuthView mode="signInOrUp" />
          </View>
        </View>
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: iosColor("systemGroupedBackground", "#F3F4F6"),
  },
  authContainer: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    backgroundColor: iosColor("systemGroupedBackground", "#F3F4F6"),
  },
  authCard: {
    gap: 12,
    borderRadius: 16,
    padding: 16,
    backgroundColor: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: iosColor("separator", "#E5E7EB"),
  },
  authTitle: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "700",
    color: iosColor("label", "#111827"),
  },
  authSubtitle: {
    fontSize: 16,
    lineHeight: 22,
    color: iosColor("secondaryLabel", "#6B7280"),
  },
  authView: {
    minHeight: 520,
  },
});
