import { type ReactNode, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  PlatformColor,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLastKnownUserId } from "../data/DataProvider";
import { authClient, useAuth } from "./auth-client";

type AuthGateProps = {
  children: ReactNode;
};

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

type Method = "code" | "password";

function errorMessage(error: { message?: string } | null | undefined, fallback: string): string {
  return error?.message?.trim() || fallback;
}

function SignInScreen() {
  const [method, setMethod] = useState<Method>("code");
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const trimmedEmail = email.trim().toLowerCase();
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);

  const switchMethod = (next: Method) => {
    setMethod(next);
    setError(null);
    setNotice(null);
    setCodeSent(false);
    setOtp("");
  };

  const handleSendCode = async () => {
    if (busy || !emailLooksValid) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
        email: trimmedEmail,
        type: "sign-in",
      });
      if (sendError) {
        setError(errorMessage(sendError, "Could not send a code. Try again."));
        return;
      }
      setCodeSent(true);
      setNotice(`We sent a 6-digit code to ${trimmedEmail}.`);
    } catch {
      setError("Could not send a code. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyCode = async () => {
    const trimmedOtp = otp.trim();
    if (busy || trimmedOtp.length < 6) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: verifyError } = await authClient.signIn.emailOtp({
        email: trimmedEmail,
        otp: trimmedOtp,
      });
      if (verifyError) {
        setError(errorMessage(verifyError, "That code didn't work. Try again."));
      }
      // On success the session updates and the gate swaps to the app.
    } catch {
      setError("Could not verify the code. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordSubmit = async () => {
    if (busy || !emailLooksValid || password.length < 8) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isSignUp) {
        const { error: signUpError } = await authClient.signUp.email({
          email: trimmedEmail,
          password,
          name: name.trim() || trimmedEmail.split("@")[0],
        });
        if (signUpError) {
          setError(errorMessage(signUpError, "Could not create the account."));
        }
      } else {
        const { error: signInError } = await authClient.signIn.email({
          email: trimmedEmail,
          password,
        });
        if (signInError) {
          setError(errorMessage(signInError, "Wrong email or password."));
        }
      }
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const passwordDisabled =
    busy || !emailLooksValid || password.length < 8 || (isSignUp && name.trim().length === 0);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text style={styles.title}>Caloric</Text>
          <Text style={styles.subtitle}>Sign in or create an account to continue.</Text>

          <View style={styles.segment}>
            <SegmentButton label="Email code" active={method === "code"} onPress={() => switchMethod("code")} />
            <SegmentButton label="Password" active={method === "password"} onPress={() => switchMethod("password")} />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={iosColor("tertiaryLabel", "#9CA3AF")}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              editable={!busy}
              style={styles.input}
            />
          </View>

          {method === "password" ? (
            <>
              {isSignUp ? (
                <View style={styles.field}>
                  <Text style={styles.label}>Name</Text>
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    placeholder="Your name"
                    placeholderTextColor={iosColor("tertiaryLabel", "#9CA3AF")}
                    autoCapitalize="words"
                    editable={!busy}
                    style={styles.input}
                  />
                </View>
              ) : null}
              <View style={styles.field}>
                <Text style={styles.label}>Password</Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="At least 8 characters"
                  placeholderTextColor={iosColor("tertiaryLabel", "#9CA3AF")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  textContentType={isSignUp ? "newPassword" : "password"}
                  editable={!busy}
                  style={styles.input}
                  onSubmitEditing={handlePasswordSubmit}
                />
              </View>
              <PrimaryButton
                label={isSignUp ? "Create account" : "Sign in"}
                disabled={passwordDisabled}
                busy={busy}
                onPress={handlePasswordSubmit}
              />
              <Pressable
                onPress={() => {
                  setIsSignUp((value) => !value);
                  setError(null);
                }}
                disabled={busy}
                hitSlop={8}
              >
                <Text style={styles.linkText}>
                  {isSignUp ? "Have an account? Sign in" : "New here? Create an account"}
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              {codeSent ? (
                <View style={styles.field}>
                  <Text style={styles.label}>Verification code</Text>
                  <TextInput
                    value={otp}
                    onChangeText={setOtp}
                    placeholder="123456"
                    placeholderTextColor={iosColor("tertiaryLabel", "#9CA3AF")}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    maxLength={6}
                    editable={!busy}
                    style={styles.input}
                    onSubmitEditing={handleVerifyCode}
                  />
                </View>
              ) : null}
              {codeSent ? (
                <>
                  <PrimaryButton
                    label="Verify code"
                    disabled={busy || otp.trim().length < 6}
                    busy={busy}
                    onPress={handleVerifyCode}
                  />
                  <Pressable onPress={handleSendCode} disabled={busy} hitSlop={8}>
                    <Text style={styles.linkText}>Resend code</Text>
                  </Pressable>
                </>
              ) : (
                <PrimaryButton
                  label="Send code"
                  disabled={busy || !emailLooksValid}
                  busy={busy}
                  onPress={handleSendCode}
                />
              )}
            </>
          )}

          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SegmentButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.segmentButton, active ? styles.segmentButtonActive : null]}
    >
      <Text style={[styles.segmentText, active ? styles.segmentTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({
  label,
  disabled,
  busy,
  onPress,
}: {
  label: string;
  disabled: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.primaryButton, disabled ? styles.primaryButtonDisabled : null]}
    >
      {busy ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <Text style={styles.primaryButtonText}>{label}</Text>
      )}
    </Pressable>
  );
}

export function AuthGate({ children }: AuthGateProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const lastKnownUserId = useLastKnownUserId();

  // Offline-first: until the session finishes loading, optimistically render the
  // app for whoever was signed in last time so cached data opens instantly with
  // no connectivity. A resolved signed-out state below falls through to sign-in.
  if (!isLoaded) {
    if (lastKnownUserId) {
      return <>{children}</>;
    }

    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={iosColor("systemBlue", "#2563EB")} />
      </View>
    );
  }

  if (!isSignedIn) {
    return <SignInScreen />;
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: iosColor("systemGroupedBackground", "#F3F4F6"),
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 32,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: iosColor("systemGroupedBackground", "#F3F4F6"),
  },
  card: {
    gap: 14,
    borderRadius: 16,
    padding: 20,
    backgroundColor: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: iosColor("separator", "#E5E7EB"),
  },
  title: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "700",
    color: iosColor("label", "#111827"),
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
    color: iosColor("secondaryLabel", "#6B7280"),
  },
  segment: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: 10,
    backgroundColor: iosColor("tertiarySystemGroupedBackground", "#EEF0F3"),
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  segmentButtonActive: {
    backgroundColor: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
  },
  segmentText: {
    fontSize: 15,
    fontWeight: "600",
    color: iosColor("secondaryLabel", "#6B7280"),
  },
  segmentTextActive: {
    color: iosColor("label", "#111827"),
  },
  field: {
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: iosColor("secondaryLabel", "#6B7280"),
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: iosColor("separator", "#D1D5DB"),
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 17,
    color: iosColor("label", "#111827"),
    backgroundColor: iosColor("systemBackground", "#FFFFFF"),
  },
  primaryButton: {
    marginTop: 4,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: iosColor("systemBlue", "#2563EB"),
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "600",
  },
  linkText: {
    textAlign: "center",
    fontSize: 15,
    fontWeight: "500",
    color: iosColor("systemBlue", "#2563EB"),
  },
  notice: {
    fontSize: 14,
    lineHeight: 20,
    color: iosColor("secondaryLabel", "#6B7280"),
  },
  error: {
    fontSize: 14,
    lineHeight: 20,
    color: iosColor("systemRed", "#DC2626"),
  },
});
