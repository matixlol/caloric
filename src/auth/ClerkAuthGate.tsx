import {
  isClerkAPIResponseError,
  useAuth,
  useSSO,
  useSignIn,
  useSignUp,
  useUser,
} from "@clerk/clerk-expo";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  PlatformColor,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAccount } from "jazz-tools/expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CaloricAccount } from "../jazz/schema";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ClerkAuthGateProps = {
  children: ReactNode;
};

type AuthScreenProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
};

type AuthMode = "sign-in" | "sign-up";
type VerificationMode = "none" | "sign-in" | "sign-up";
type SocialStrategy = "oauth_google";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

const palette = {
  background: iosColor("systemGroupedBackground", "#F3F4F6"),
  card: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
  label: iosColor("label", "#111827"),
  secondaryLabel: iosColor("secondaryLabel", "#6B7280"),
  tertiaryLabel: iosColor("tertiaryLabel", "#9CA3AF"),
  separator: iosColor("separator", "#E5E7EB"),
  tint: iosColor("systemBlue", "#2563EB"),
  buttonDisabled: iosColor("systemGray3", "#D1D5DB"),
  error: iosColor("systemRed", "#DC2626"),
  white: iosColor("white", "#FFFFFF"),
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function sanitizeProviderMentions(value: string) {
  return value.replace(/clerk/gi, "auth");
}

function getAuthErrorMessage(error: unknown) {
  if (isClerkAPIResponseError(error) && error.errors.length > 0) {
    const firstError = error.errors[0];
    return sanitizeProviderMentions(
      firstError.longMessage || firstError.message || "Authentication failed.",
    );
  }

  if (error instanceof Error) {
    return sanitizeProviderMentions(error.message);
  }

  return "Authentication failed.";
}

function AuthScreen({ title, subtitle, children }: AuthScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.screen}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.authContentContainer,
          {
            paddingTop: insets.top + 24,
            paddingBottom: insets.bottom + 24,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.authTitle}>{title}</Text>
        <Text style={styles.authSubtitle}>{subtitle}</Text>
        <View style={styles.authCard}>{children}</View>
      </ScrollView>
    </View>
  );
}

function LabeledInput({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  secureTextEntry?: boolean;
  keyboardType?: "default" | "email-address" | "number-pad";
}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.tertiaryLabel}
        style={styles.textInput}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
        keyboardType={keyboardType}
      />
    </View>
  );
}

export function ClerkAuthGate({ children }: ClerkAuthGateProps) {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { startSSOFlow } = useSSO();
  const { isLoaded: signInLoaded, signIn, setActive: setSignInActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp, setActive: setSignUpActive } = useSignUp();
  const me = useAccount(CaloricAccount, { resolve: { profile: true } });

  const [authMode, setAuthMode] = useState<AuthMode>("sign-in");
  const [verificationMode, setVerificationMode] = useState<VerificationMode>("none");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const currentEmail = useMemo(() => {
    if (!me.$isLoaded) return "";
    return normalizeEmail(me.profile.email);
  }, [me]);

  useEffect(() => {
    if (!isSignedIn || !me.$isLoaded || currentEmail) {
      return;
    }

    const clerkEmail = normalizeEmail(user?.primaryEmailAddress?.emailAddress || "");
    if (EMAIL_REGEX.test(clerkEmail)) {
      me.profile.$jazz.set("email", clerkEmail);
    }
  }, [currentEmail, isSignedIn, me, user]);

  const emailIsValid = EMAIL_REGEX.test(normalizeEmail(emailInput));

  const resetMessages = () => {
    setError(null);
    setInfo(null);
  };

  const switchAuthMode = (nextMode: AuthMode) => {
    setAuthMode(nextMode);
    setVerificationMode("none");
    setCodeInput("");
    resetMessages();
  };

  const handleSignIn = async () => {
    if (!signInLoaded || !setSignInActive) {
      return;
    }

    const email = normalizeEmail(emailInput);
    if (!EMAIL_REGEX.test(email)) {
      setError("Enter a valid email.");
      return;
    }

    if (!passwordInput.trim()) {
      setError("Enter your password.");
      return;
    }

    resetMessages();
    setBusy(true);

    try {
      const signInAttempt = await signIn.create({
        identifier: email,
        password: passwordInput,
      });

      if (signInAttempt.status === "complete" && signInAttempt.createdSessionId) {
        await setSignInActive({ session: signInAttempt.createdSessionId });
        return;
      }

      if (signInAttempt.status === "needs_second_factor") {
        const emailCodeSupported =
          signInAttempt.supportedSecondFactors?.some(
            (factor) => factor.strategy === "email_code",
          ) ?? false;

        if (!emailCodeSupported) {
          setError("This account requires a second factor that is not supported in this screen.");
          return;
        }

        await signInAttempt.prepareSecondFactor({ strategy: "email_code" });
        setVerificationMode("sign-in");
        setInfo("Enter the email verification code to complete sign in.");
        return;
      }

      setError("Sign in could not be completed. Please try again.");
    } catch (signInError) {
      setError(getAuthErrorMessage(signInError));
    } finally {
      setBusy(false);
    }
  };

  const handleSignInVerification = async () => {
    if (!signInLoaded || !setSignInActive) {
      return;
    }

    const code = codeInput.trim();
    if (!code) {
      setError("Enter the verification code.");
      return;
    }

    resetMessages();
    setBusy(true);

    try {
      const result = await signIn.attemptSecondFactor({
        strategy: "email_code",
        code,
      });

      if (result.status === "complete" && result.createdSessionId) {
        await setSignInActive({ session: result.createdSessionId });
        return;
      }

      setError("Verification is incomplete. Request a new code and try again.");
    } catch (verificationError) {
      setError(getAuthErrorMessage(verificationError));
    } finally {
      setBusy(false);
    }
  };

  const handleSignUp = async () => {
    if (!signUpLoaded || !setSignUpActive) {
      return;
    }

    const email = normalizeEmail(emailInput);
    if (!EMAIL_REGEX.test(email)) {
      setError("Enter a valid email.");
      return;
    }

    if (!passwordInput.trim()) {
      setError("Enter a password.");
      return;
    }

    resetMessages();
    setBusy(true);

    try {
      const signUpAttempt = await signUp.create({
        emailAddress: email,
        password: passwordInput,
      });

      if (signUpAttempt.status === "complete" && signUpAttempt.createdSessionId) {
        await setSignUpActive({ session: signUpAttempt.createdSessionId });
        return;
      }

      await signUpAttempt.prepareEmailAddressVerification({ strategy: "email_code" });
      setVerificationMode("sign-up");
      setInfo("We sent a verification code to your email.");
    } catch (signUpError) {
      setError(getAuthErrorMessage(signUpError));
    } finally {
      setBusy(false);
    }
  };

  const handleSignUpVerification = async () => {
    if (!signUpLoaded || !setSignUpActive) {
      return;
    }

    const code = codeInput.trim();
    if (!code) {
      setError("Enter the verification code.");
      return;
    }

    resetMessages();
    setBusy(true);

    try {
      const verificationAttempt = await signUp.attemptEmailAddressVerification({
        code,
      });

      if (
        verificationAttempt.status === "complete" &&
        verificationAttempt.createdSessionId
      ) {
        await setSignUpActive({ session: verificationAttempt.createdSessionId });
        return;
      }

      setError("Verification is incomplete. Request a new code and try again.");
    } catch (verificationError) {
      setError(getAuthErrorMessage(verificationError));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEmail = () => {
    if (!me.$isLoaded) return;

    const normalizedEmail = normalizeEmail(emailInput);
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      setError("Enter a valid email.");
      return;
    }

    setError(null);
    me.profile.$jazz.set("email", normalizedEmail);
  };

  const handleSocialSignIn = async (strategy: SocialStrategy) => {
    resetMessages();
    setBusy(true);

    try {
      const { createdSessionId, setActive, authSessionResult } = await startSSOFlow({
        strategy,
      });

      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        return;
      }

      if (authSessionResult?.type === "cancel") {
        setInfo("Sign in was canceled.");
        return;
      }

      setInfo("Continue in browser to finish sign in.");
    } catch (socialError) {
      setError(getAuthErrorMessage(socialError));
    } finally {
      setBusy(false);
    }
  };

  if (!authLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={palette.tint} />
      </View>
    );
  }

  if (!isSignedIn) {
    const showingVerification = verificationMode !== "none";
    const isSigningIn = authMode === "sign-in";
    const isPrimaryDisabled = showingVerification
      ? busy || !codeInput.trim()
      : busy || !emailIsValid || !passwordInput.trim();

    return (
      <AuthScreen
        title={showingVerification ? "Verify" : isSigningIn ? "Sign In" : "Sign Up"}
        subtitle={
          showingVerification
            ? "Enter the one-time code sent to your email."
            : isSigningIn
              ? "Sign in to continue."
              : "Create an account to continue."
        }
      >
        {!showingVerification ? (
          <View style={styles.formStack}>
            <LabeledInput
              label="Email"
              value={emailInput}
              onChangeText={setEmailInput}
              placeholder="you@company.com"
              keyboardType="email-address"
            />
            <LabeledInput
              label="Password"
              value={passwordInput}
              onChangeText={setPasswordInput}
              placeholder="••••••••"
              secureTextEntry
            />
          </View>
        ) : (
          <LabeledInput
            label="Verification Code"
            value={codeInput}
            onChangeText={setCodeInput}
            placeholder="123456"
            keyboardType="number-pad"
          />
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {info ? <Text style={styles.infoText}>{info}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            disabled={isPrimaryDisabled}
            onPress={
              showingVerification
                ? verificationMode === "sign-up"
                  ? handleSignUpVerification
                  : handleSignInVerification
                : isSigningIn
                  ? handleSignIn
                  : handleSignUp
            }
            style={[styles.primaryButton, isPrimaryDisabled && styles.primaryButtonDisabled]}
          >
            <Text style={styles.primaryButtonText}>
              {showingVerification
                ? "Verify Code"
                : isSigningIn
                  ? "Sign In"
                  : "Create Account"}
            </Text>
          </Pressable>

          {!showingVerification ? (
            <>
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or continue with</Text>
                <View style={styles.dividerLine} />
              </View>

              <Pressable
                disabled={busy}
                onPress={() => handleSocialSignIn("oauth_google")}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Continue with Google</Text>
              </Pressable>
            </>
          ) : null}

          <Pressable
            disabled={busy}
            onPress={() => {
              if (showingVerification) {
                setVerificationMode("none");
                setCodeInput("");
                resetMessages();
                return;
              }

              switchAuthMode(isSigningIn ? "sign-up" : "sign-in");
            }}
            style={styles.tertiaryButton}
          >
            <Text style={styles.tertiaryButtonText}>
              {showingVerification
                ? "Use Different Method"
                : isSigningIn
                  ? "Need an account? Sign Up"
                  : "Already have an account? Sign In"}
            </Text>
          </Pressable>
        </View>
      </AuthScreen>
    );
  }

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={palette.tint} />
      </View>
    );
  }

  if (!currentEmail) {
    return (
      <AuthScreen
        title="Add Email"
        subtitle="Your account requires an email. This is stored on your public profile."
      >
        <LabeledInput
          label="Email"
          value={emailInput}
          onChangeText={setEmailInput}
          placeholder="you@company.com"
          keyboardType="email-address"
        />
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable onPress={handleSaveEmail} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Save Email</Text>
          </Pressable>
        </View>
      </AuthScreen>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.background,
  },
  authContentContainer: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  authTitle: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "700",
    color: palette.label,
  },
  authSubtitle: {
    marginTop: 6,
    marginBottom: 16,
    fontSize: 16,
    lineHeight: 22,
    color: palette.secondaryLabel,
  },
  authCard: {
    borderRadius: 16,
    padding: 16,
    backgroundColor: palette.card,
  },
  formStack: {
    gap: 12,
  },
  inputGroup: {
    gap: 6,
  },
  inputLabel: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.secondaryLabel,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  textInput: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.separator,
    backgroundColor: palette.white,
    paddingHorizontal: 12,
    fontSize: 17,
    color: palette.label,
  },
  errorText: {
    marginTop: 12,
    fontSize: 14,
    lineHeight: 20,
    color: palette.error,
    fontWeight: "500",
  },
  infoText: {
    marginTop: 12,
    fontSize: 14,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
  actions: {
    marginTop: 14,
    gap: 10,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.tint,
  },
  primaryButtonDisabled: {
    backgroundColor: palette.buttonDisabled,
  },
  primaryButtonText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: "#FFFFFF",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: palette.separator,
  },
  dividerText: {
    fontSize: 12,
    lineHeight: 16,
    color: palette.tertiaryLabel,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.separator,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.white,
  },
  secondaryButtonText: {
    fontSize: 16,
    lineHeight: 21,
    color: palette.label,
    fontWeight: "500",
  },
  tertiaryButton: {
    minHeight: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  tertiaryButtonText: {
    fontSize: 15,
    lineHeight: 20,
    color: palette.tint,
    fontWeight: "500",
  },
});
