import { createClerkClient } from "@clerk/backend";
import { config } from "./config";

const clerkClient = createClerkClient({
  secretKey: config.clerkSecretKey,
  publishableKey: config.clerkPublishableKey,
  jwtKey: config.clerkJwtKey,
});

export async function authenticateUserRequest(request: Request): Promise<{
  userId: string;
}> {
  const requestState = await clerkClient.authenticateRequest(request, {
    acceptsToken: "session_token",
  });

  if (!requestState.isAuthenticated) {
    throw new Error("unauthorized");
  }

  const auth = requestState.toAuth();
  if (!auth.userId) {
    throw new Error("unauthorized");
  }

  return {
    userId: auth.userId,
  };
}
