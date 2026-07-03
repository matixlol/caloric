import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { config } from "./config";
import { db } from "./db";
import { account, session, user, verification } from "./db/schema";
import { loginCodeEmail, sendEmail } from "./services/email";

// The app deep-link schemes (production + dev build) that Better Auth must
// treat as trusted origins for the Expo integration.
const APP_SCHEMES = ["caloric://", "caloric://*", "caloric-dev://", "caloric-dev://*"];

// Expo Go / dev-server origins are only trusted outside production.
const DEV_ORIGINS =
  process.env.NODE_ENV === "production" ? [] : ["exp://", "exp://*", "exp://**"];

export const auth = betterAuth({
  secret: config.betterAuthSecret,
  baseURL: config.betterAuthUrl,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  trustedOrigins: [
    ...APP_SCHEMES,
    ...DEV_ORIGINS,
    ...config.webOrigins,
    ...config.authTrustedOrigins,
  ],
  emailAndPassword: {
    // Password login — required for App Store review's demo account, and a
    // stable fallback that does not depend on email delivery.
    enabled: true,
    // These are private, invite-only accounts; skip the verification email
    // gate so a freshly-seeded/created account can sign in immediately.
    requireEmailVerification: false,
  },
  plugins: [
    // Email-code login (replaces Clerk's email verification code). Also
    // auto-registers a user the first time they sign in with a code.
    emailOTP({
      otpLength: 6,
      expiresIn: 300,
      async sendVerificationOTP({ email, otp }) {
        const { subject, text, html } = loginCodeEmail(otp);
        await sendEmail({ to: email, subject, text, html });
      },
    }),
    // Native session storage + trusted-origin handling for the Expo client.
    expo(),
  ],
});

export async function authenticateUserRequest(request: Request): Promise<{
  userId: string;
}> {
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session?.user?.id) {
    throw new Error("unauthorized");
  }

  return {
    userId: session.user.id,
  };
}
