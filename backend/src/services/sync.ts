import { USER_SETTINGS_ROW_ID } from "@caloric/data-model";
import { and, eq, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { userFoodEntries, userSettings } from "../db/schema";
import { isObjectRecord, jsonResponse, requireAuthenticatedUser } from "../http";
import { logError, summarizeText } from "../logging";
import { Sentry } from "../lib/sentry";
import { parseSyncPushBody, shouldApplyIncomingWrite } from "../sync";

function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function reportUnknownError(code: string, error: unknown): Response {
  const errorForCapture =
    error instanceof Error ? error : new Error(`${code}: ${summarizeText(stringifyUnknownError(error), 500)}`);

  Sentry.getActiveSpan()?.setAttributes({
    "app.error.code": code,
    "app.error.exposed": false,
  });

  logError(`api.${code}`, errorForCapture);
  Sentry.captureException(errorForCapture);

  return jsonResponse(
    {
      error: code,
      message: "Unknown error.",
    },
    502,
  );
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function dateFromMillis(value: number | null | undefined): Date | null {
  if (typeof value !== "number") {
    return null;
  }

  return new Date(value);
}

async function upsertUserFoodEntry(
  userId: string,
  row: ReturnType<typeof parseSyncPushBody>["foodEntries"][number],
): Promise<boolean> {
  const existing = await db
    .select({ updatedAt: userFoodEntries.updatedAt })
    .from(userFoodEntries)
    .where(and(eq(userFoodEntries.userId, userId), eq(userFoodEntries.id, row.id)))
    .limit(1);

  if (!shouldApplyIncomingWrite(existing[0]?.updatedAt, row.updatedAt)) {
    return false;
  }

  const nextUpdatedAt = new Date(row.updatedAt);
  const nextDeletedAt = dateFromMillis(row.deletedAt ?? null);

  await db
    .insert(userFoodEntries)
    .values({
      userId,
      id: row.id,
      data: row.data,
      updatedAt: nextUpdatedAt,
      deletedAt: nextDeletedAt,
    })
    .onConflictDoUpdate({
      target: [userFoodEntries.userId, userFoodEntries.id],
      set: {
        data: row.data,
        updatedAt: nextUpdatedAt,
        deletedAt: nextDeletedAt,
      },
      setWhere: lte(userFoodEntries.updatedAt, nextUpdatedAt),
    });

  return true;
}

async function upsertUserSettingsRow(
  userId: string,
  row: NonNullable<ReturnType<typeof parseSyncPushBody>["settings"]>,
): Promise<boolean> {
  const existing = await db
    .select({ updatedAt: userSettings.updatedAt })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  if (!shouldApplyIncomingWrite(existing[0]?.updatedAt, row.updatedAt)) {
    return false;
  }

  const nextUpdatedAt = new Date(row.updatedAt);

  await db
    .insert(userSettings)
    .values({
      userId,
      data: row.data,
      updatedAt: nextUpdatedAt,
    })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        data: row.data,
        updatedAt: nextUpdatedAt,
      },
      setWhere: lte(userSettings.updatedAt, nextUpdatedAt),
    });

  return true;
}

export async function handleSyncBootstrapRequest(request: Request): Promise<Response> {
  const auth = await requireAuthenticatedUser(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const [foodEntryRows, settingsRows] = await Promise.all([
      db
        .select({
          id: userFoodEntries.id,
          data: userFoodEntries.data,
          updatedAt: userFoodEntries.updatedAt,
        })
        .from(userFoodEntries)
        .where(and(eq(userFoodEntries.userId, auth.userId), isNull(userFoodEntries.deletedAt)))
        .orderBy(userFoodEntries.updatedAt),
      db
        .select({
          data: userSettings.data,
          updatedAt: userSettings.updatedAt,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, auth.userId))
        .limit(1),
    ]);

    return jsonResponse({
      foodEntries: foodEntryRows.map((row) => ({
        id: row.id,
        data: row.data,
        updatedAt: row.updatedAt.getTime(),
      })),
      settings: settingsRows[0]
        ? {
            id: USER_SETTINGS_ROW_ID,
            data: settingsRows[0].data,
            updatedAt: settingsRows[0].updatedAt.getTime(),
          }
        : null,
    });
  } catch (error) {
    return reportUnknownError("sync_bootstrap_failed", error);
  }
}

export async function handleSyncPushRequest(request: Request): Promise<Response> {
  const auth = await requireAuthenticatedUser(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const body = parseSyncPushBody(await parseJsonBody(request));
    const acceptedFoodEntryIds: string[] = [];

    for (const row of body.foodEntries) {
      if (await upsertUserFoodEntry(auth.userId, row)) {
        acceptedFoodEntryIds.push(row.id);
      }
    }

    let acceptedSettings = false;
    if (body.settings) {
      acceptedSettings = await upsertUserSettingsRow(auth.userId, body.settings);
    }

    return jsonResponse({
      acceptedFoodEntryIds,
      acceptedSettings,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      return jsonResponse({ error: "Invalid sync payload" }, 400);
    }

    return reportUnknownError("sync_push_failed", error);
  }
}
