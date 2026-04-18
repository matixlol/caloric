import { useAuth } from "@clerk/expo";
import { SignIn } from "@clerk/expo/web";
import { type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

type ClerkAuthGateProps = {
  children: ReactNode;
};

export function ClerkAuthGate({ children }: ClerkAuthGateProps) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563EB" />
      </View>
    );
  }

  if (!isSignedIn) {
    return (
      <View style={styles.authContainer}>
        <SignIn withSignUp />
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
    backgroundColor: "#F3F4F6",
  },
  authContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#F3F4F6",
  },
});
