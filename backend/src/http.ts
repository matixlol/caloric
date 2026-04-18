import { authenticateUserRequest } from "./auth";

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function jsonResponse(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function requireAuthenticatedUser(request: Request): Promise<{ userId: string } | Response> {
  try {
    return await authenticateUserRequest(request);
  } catch {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
}
