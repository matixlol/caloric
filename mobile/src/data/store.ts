import {
  FriendDailyDayResponseSchema,
  type FriendDailyDayResponse,
  DEFAULT_USER_SETTINGS,
  FriendDailySummariesResponseSchema,
  type FriendDailySummary,
  FoodEntrySchema,
  type FoodEntry,
  MealSchema,
  type Meal,
  SocialOverviewSchema,
  type SocialOverview,
  USER_SETTINGS_ROW_ID,
  UserSettingsSchema,
  type UserSettings,
} from "@caloric/data-model";
import { open, type DB, type Scalar, type Transaction } from "@op-engineering/op-sqlite";
import { createFoodEntryId } from "../id";

const BACKEND_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL?.trim() ?? "").replace(/\/+$/, "") ||
  "https://backend.caloric.mati.lol";

const DB_NAME = "caloric-local";
const CURRENT_USER_META_KEY = "current_user_id";
const DEFAULT_SYNC_DELAY_MS = 800;

export type FoodEntryRecord = FoodEntry & {
  id: string;
  updatedAt: number;
  deletedAt: number | null;
  dirty: boolean;
};

export type UserSettingsRecord = UserSettings & {
  id: typeof USER_SETTINGS_ROW_ID;
  updatedAt: number;
  dirty: boolean;
};

export type SyncStatusRecord = {
  updatedAt: number;
  dirty: boolean;
};

type SqlRow = Record<string, Scalar>;
type TokenProvider = () => Promise<string | null>;
type BackendRequestOptions = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asString(value: Scalar | undefined, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string`);
  }

  return value;
}

function asNumber(value: Scalar | undefined, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Expected ${field} to be a number`);
  }

  return value;
}

function parseFoodEntryRow(row: SqlRow): FoodEntryRecord {
  const payload = FoodEntrySchema.parse(JSON.parse(asString(row.payload_json, "payload_json")));

  return {
    id: asString(row.id, "id"),
    updatedAt: asNumber(row.updated_at, "updated_at"),
    deletedAt: row.deleted_at === null ? null : asNumber(row.deleted_at, "deleted_at"),
    dirty: asNumber(row.dirty, "dirty") === 1,
    ...payload,
  };
}

function parseUserSettingsRow(row: SqlRow): UserSettingsRecord {
  const payload = UserSettingsSchema.parse(JSON.parse(asString(row.payload_json, "payload_json")));

  return {
    id: USER_SETTINGS_ROW_ID,
    updatedAt: asNumber(row.updated_at, "updated_at"),
    dirty: asNumber(row.dirty, "dirty") === 1,
    ...payload,
  };
}

async function fetchJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function parseBackendError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }

  return fallback;
}

export class LocalDataStore {
  private db: DB | null = null;
  private initializePromise: Promise<void> | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private revision = 0;
  private listeners = new Set<() => void>();
  private activeUserId: string | null = null;
  private tokenProvider: TokenProvider | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncInFlight = false;
  private syncQueued = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  getRevision = () => this.revision;

  async initialize(): Promise<void> {
    if (this.db) {
      return;
    }

    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        this.db = open({ name: DB_NAME });
        this.db.executeSync("PRAGMA journal_mode = WAL");
        this.db.executeSync(`
          CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
          )
        `);
        this.db.executeSync(`
          CREATE TABLE IF NOT EXISTS food_entries (
            id TEXT PRIMARY KEY NOT NULL,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            dirty INTEGER NOT NULL DEFAULT 1
          )
        `);
        this.db.executeSync(`
          CREATE TABLE IF NOT EXISTS user_settings (
            id TEXT PRIMARY KEY NOT NULL,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            dirty INTEGER NOT NULL DEFAULT 1
          )
        `);
        this.db.executeSync(`
          CREATE INDEX IF NOT EXISTS food_entries_date_key_idx
          ON food_entries (json_extract(payload_json, '$.dateKey'))
          WHERE deleted_at IS NULL
        `);
        this.db.executeSync(`
          CREATE INDEX IF NOT EXISTS food_entries_dirty_idx
          ON food_entries (dirty, updated_at)
        `);
        this.db.executeSync(`
          CREATE INDEX IF NOT EXISTS user_settings_dirty_idx
          ON user_settings (dirty, updated_at)
        `);
      })().finally(() => {
        this.initializePromise = null;
      });
    }

    await this.initializePromise;
  }

  async activateUser(userId: string, tokenProvider: TokenProvider): Promise<void> {
    await this.initialize();
    this.bootstrapPromise = null;
    this.activeUserId = userId;
    this.tokenProvider = tokenProvider;

    const currentUserId = await this.getMeta(CURRENT_USER_META_KEY);
    if (currentUserId !== userId) {
      await this.withTransaction(async (tx) => {
        await tx.execute("DELETE FROM food_entries");
        await tx.execute("DELETE FROM user_settings");
        await tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
          CURRENT_USER_META_KEY,
          userId,
        ]);
        await this.ensureDefaultSettingsRow(tx);
      });
      this.bumpRevision();
    } else {
      await this.ensureDefaultSettingsRow(this.getDb());
    }
  }

  deactivateUser(): void {
    this.bootstrapPromise = null;
    this.activeUserId = null;
    this.tokenProvider = null;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async getFoodEntry(id: string): Promise<FoodEntryRecord | null> {
    await this.initialize();
    const result = await this.getDb().execute(
      `
        SELECT id, payload_json, updated_at, deleted_at, dirty
        FROM food_entries
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1
      `,
      [id],
    );

    return result.rows[0] ? parseFoodEntryRow(result.rows[0] as SqlRow) : null;
  }

  async listFoodEntriesByDate(dateKey: string): Promise<FoodEntryRecord[]> {
    await this.initialize();
    const result = await this.getDb().execute(
      `
        SELECT id, payload_json, updated_at, deleted_at, dirty
        FROM food_entries
        WHERE deleted_at IS NULL
          AND json_extract(payload_json, '$.dateKey') = ?
        ORDER BY
          CASE json_extract(payload_json, '$.meal')
            WHEN 'breakfast' THEN 0
            WHEN 'lunch' THEN 1
            WHEN 'dinner' THEN 2
            WHEN 'snacks' THEN 3
            ELSE 4
          END ASC,
          CAST(json_extract(payload_json, '$.sortIndex') AS REAL) ASC,
          CAST(json_extract(payload_json, '$.createdAt') AS INTEGER) ASC,
          id ASC
      `,
      [dateKey],
    );

    return result.rows.map((row) => parseFoodEntryRow(row as SqlRow));
  }

  async listAllFoodEntries(): Promise<FoodEntryRecord[]> {
    await this.initialize();
    const result = await this.getDb().execute(
      `
        SELECT id, payload_json, updated_at, deleted_at, dirty
        FROM food_entries
        WHERE deleted_at IS NULL
        ORDER BY
          CAST(json_extract(payload_json, '$.createdAt') AS INTEGER) ASC,
          id ASC
      `,
    );

    return result.rows.map((row) => parseFoodEntryRow(row as SqlRow));
  }

  async getUserSettings(): Promise<UserSettingsRecord> {
    await this.initialize();
    const result = await this.getDb().execute(
      `
        SELECT id, payload_json, updated_at, dirty
        FROM user_settings
        WHERE id = ?
        LIMIT 1
      `,
      [USER_SETTINGS_ROW_ID],
    );

    if (!result.rows[0]) {
      return {
        id: USER_SETTINGS_ROW_ID,
        updatedAt: 0,
        dirty: false,
        ...DEFAULT_USER_SETTINGS,
      };
    }

    return parseUserSettingsRow(result.rows[0] as SqlRow);
  }

  async getSyncStatus(): Promise<SyncStatusRecord> {
    await this.initialize();
    const [foodEntriesResult, settingsResult] = await Promise.all([
      this.getDb().execute(
        `
          SELECT MAX(updated_at) AS updated_at, MAX(dirty) AS dirty
          FROM food_entries
        `,
      ),
      this.getDb().execute(
        `
          SELECT MAX(updated_at) AS updated_at, MAX(dirty) AS dirty
          FROM user_settings
        `,
      ),
    ]);

    const foodEntriesRow = (foodEntriesResult.rows[0] ?? {}) as SqlRow;
    const settingsRow = (settingsResult.rows[0] ?? {}) as SqlRow;
    const foodEntriesUpdatedAt = typeof foodEntriesRow.updated_at === "number" ? foodEntriesRow.updated_at : 0;
    const settingsUpdatedAt = typeof settingsRow.updated_at === "number" ? settingsRow.updated_at : 0;
    const hasDirtyFoodEntries = foodEntriesRow.dirty === 1;
    const hasDirtySettings = settingsRow.dirty === 1;

    return {
      updatedAt: Math.max(foodEntriesUpdatedAt, settingsUpdatedAt),
      dirty: hasDirtyFoodEntries || hasDirtySettings,
    };
  }

  async createFoodEntry(
    input: Omit<FoodEntry, "sortIndex">,
  ): Promise<FoodEntryRecord> {
    await this.initialize();

    const id = createFoodEntryId();
    const sortIndex = await this.getNextSortIndex(input.dateKey, input.meal);
    const nextEntry = FoodEntrySchema.parse({
      ...input,
      sortIndex,
    });
    const updatedAt = Date.now();

    await this.withTransaction(async (tx) => {
      await tx.execute(
        `
          INSERT INTO food_entries (id, payload_json, updated_at, deleted_at, dirty)
          VALUES (?, ?, ?, NULL, 1)
        `,
        [id, JSON.stringify(nextEntry), updatedAt],
      );
    });

    this.bumpRevision();
    this.scheduleSync();

    return {
      id,
      updatedAt,
      deletedAt: null,
      dirty: true,
      ...nextEntry,
    };
  }

  async updateFoodEntry(
    id: string,
    updater: (current: FoodEntryRecord) => FoodEntry,
  ): Promise<FoodEntryRecord | null> {
    await this.initialize();
    const current = await this.getFoodEntry(id);
    if (!current) {
      return null;
    }

    const nextEntry = FoodEntrySchema.parse(updater(current));
    const updatedAt = Date.now();

    await this.withTransaction(async (tx) => {
      await tx.execute(
        `
          UPDATE food_entries
          SET payload_json = ?, updated_at = ?, dirty = 1
          WHERE id = ?
        `,
        [JSON.stringify(nextEntry), updatedAt, id],
      );
    });

    this.bumpRevision();
    this.scheduleSync();

    return {
      id,
      updatedAt,
      deletedAt: null,
      dirty: true,
      ...nextEntry,
    };
  }

  async deleteFoodEntry(id: string): Promise<void> {
    await this.initialize();
    const updatedAt = Date.now();

    await this.withTransaction(async (tx) => {
      await tx.execute(
        `
          UPDATE food_entries
          SET deleted_at = ?, updated_at = ?, dirty = 1
          WHERE id = ?
        `,
        [updatedAt, updatedAt, id],
      );
    });

    this.bumpRevision();
    this.scheduleSync();
  }

  async reorderFoodEntriesForDate(
    dateKey: string,
    orderedEntries: { id: string; meal: Meal }[],
  ): Promise<void> {
    await this.initialize();
    const normalizedEntries = orderedEntries.map((entry) => ({
      id: entry.id,
      meal: MealSchema.parse(entry.meal),
    }));

    const latestRows = await this.listFoodEntriesByDate(dateKey);
    const rowsById = new Map(latestRows.map((row) => [row.id, row] as const));
    const updatedAt = Date.now();

    await this.withTransaction(async (tx) => {
      const perMealSortIndex = new Map<Meal, number>();

      for (const entry of normalizedEntries) {
        const current = rowsById.get(entry.id);
        if (!current) {
          continue;
        }

        const nextSortIndex = perMealSortIndex.get(entry.meal) ?? 0;
        perMealSortIndex.set(entry.meal, nextSortIndex + 1);

        const nextPayload = FoodEntrySchema.parse({
          meal: entry.meal,
          foodName: current.foodName,
          brand: current.brand,
          serving: current.serving,
          portion: current.portion,
          nutrition: current.nutrition,
          createdAt: current.createdAt,
          dateKey: current.dateKey,
          sortIndex: nextSortIndex,
        });

        await tx.execute(
          `
            UPDATE food_entries
            SET payload_json = ?, updated_at = ?, dirty = 1
            WHERE id = ?
          `,
          [JSON.stringify(nextPayload), updatedAt, entry.id],
        );
      }
    });

    this.bumpRevision();
    this.scheduleSync();
  }

  async upsertUserSettings(settings: UserSettings): Promise<UserSettingsRecord> {
    await this.initialize();
    const nextSettings = UserSettingsSchema.parse(settings);
    const updatedAt = Date.now();

    await this.withTransaction(async (tx) => {
      await tx.execute(
        `
          INSERT INTO user_settings (id, payload_json, updated_at, dirty)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at,
            dirty = 1
        `,
        [USER_SETTINGS_ROW_ID, JSON.stringify(nextSettings), updatedAt],
      );
    });

    this.bumpRevision();
    this.scheduleSync();

    return {
      id: USER_SETTINGS_ROW_ID,
      updatedAt,
      dirty: true,
      ...nextSettings,
    };
  }

  scheduleSync(delayMs: number = DEFAULT_SYNC_DELAY_MS): void {
    if (!this.activeUserId || !this.tokenProvider) {
      return;
    }

    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }

    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncDirtyRows();
    }, delayMs);
  }

  async bootstrapFromBackend(): Promise<void> {
    await this.initialize();
    if (this.bootstrapPromise) {
      return this.bootstrapPromise;
    }

    this.bootstrapPromise = (async () => {
      const activeUserId = this.activeUserId;
      const tokenProvider = this.tokenProvider;

      if (!activeUserId || !tokenProvider) {
        return;
      }

      const token = await tokenProvider();
      if (!token || this.activeUserId !== activeUserId || this.tokenProvider !== tokenProvider) {
        return;
      }

      let response: Response;
      try {
        response = await fetch(`${BACKEND_BASE_URL}/sync/bootstrap`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      } catch {
        return;
      }

      if (!response.ok || this.activeUserId !== activeUserId || this.tokenProvider !== tokenProvider) {
        return;
      }

      const payload = await fetchJson<{
        foodEntries?: {
          id: string;
          data: FoodEntry;
          updatedAt: number;
        }[];
        settings?: {
          id: typeof USER_SETTINGS_ROW_ID;
          data: UserSettings;
          updatedAt: number;
        } | null;
      }>(response);

      if (!payload || this.activeUserId !== activeUserId || this.tokenProvider !== tokenProvider) {
        return;
      }

      const foodEntries = payload.foodEntries ?? [];
      const currentFoodEntriesById = await this.getFoodEntryRowsByIds(foodEntries.map((row) => row.id));
      const currentSettings = payload.settings ? await this.getUserSettingsRow() : null;
      let changed = false;

      await this.withTransaction(async (tx) => {
        for (const row of foodEntries) {
          const current = currentFoodEntriesById.get(row.id);
          if (!current || row.updatedAt >= current.updatedAt) {
            await tx.execute(
              `
                INSERT INTO food_entries (id, payload_json, updated_at, deleted_at, dirty)
                VALUES (?, ?, ?, NULL, 0)
                ON CONFLICT(id) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at,
                  deleted_at = NULL,
                  dirty = 0
                WHERE food_entries.updated_at <= excluded.updated_at
              `,
              [row.id, JSON.stringify(FoodEntrySchema.parse(row.data)), row.updatedAt],
            );
            changed = true;
          }
        }

        if (payload.settings) {
          const nextSettings = UserSettingsSchema.parse(payload.settings.data);

          if (!currentSettings || payload.settings.updatedAt >= currentSettings.updatedAt) {
            await tx.execute(
              `
                INSERT INTO user_settings (id, payload_json, updated_at, dirty)
                VALUES (?, ?, ?, 0)
                ON CONFLICT(id) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at,
                  dirty = 0
                WHERE user_settings.updated_at <= excluded.updated_at
              `,
              [USER_SETTINGS_ROW_ID, JSON.stringify(nextSettings), payload.settings.updatedAt],
            );
            changed = true;
          }
        } else {
          await this.ensureDefaultSettingsRow(tx);
        }
      });

      if (changed) {
        this.bumpRevision();
      }
    })().finally(() => {
      this.bootstrapPromise = null;
    });

    return this.bootstrapPromise;
  }

  async syncDirtyRows(): Promise<void> {
    await this.initialize();
    if (!this.activeUserId || !this.tokenProvider) {
      return;
    }

    if (this.syncInFlight) {
      this.syncQueued = true;
      return;
    }

    const token = await this.tokenProvider();
    if (!token) {
      return;
    }

    const dirtyFoodEntries = await this.getDirtyFoodEntryRows();
    const dirtySettings = await this.getDirtySettingsRow();

    if (dirtyFoodEntries.length === 0 && !dirtySettings) {
      return;
    }

    this.syncInFlight = true;

    try {
      const response = await fetch(`${BACKEND_BASE_URL}/sync/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          foodEntries: dirtyFoodEntries.map((row) => ({
            id: row.id,
            data: FoodEntrySchema.parse({
              meal: row.meal,
              foodName: row.foodName,
              brand: row.brand,
              serving: row.serving,
              portion: row.portion,
              nutrition: row.nutrition,
              createdAt: row.createdAt,
              dateKey: row.dateKey,
              sortIndex: row.sortIndex,
            }),
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          })),
          settings: dirtySettings
            ? {
                id: USER_SETTINGS_ROW_ID,
                data: UserSettingsSchema.parse({
                  calorieGoal: dirtySettings.calorieGoal,
                  macroProteinPct: dirtySettings.macroProteinPct,
                  macroCarbsPct: dirtySettings.macroCarbsPct,
                  macroFatPct: dirtySettings.macroFatPct,
                }),
                updatedAt: dirtySettings.updatedAt,
              }
            : undefined,
        }),
      });

      const payload = await fetchJson<{
        acceptedFoodEntryIds?: string[];
        acceptedSettings?: boolean;
      }>(response);

      if (!response.ok) {
        return;
      }

      await this.withTransaction(async (tx) => {
        for (const row of dirtyFoodEntries) {
          if (!payload?.acceptedFoodEntryIds?.includes(row.id)) {
            continue;
          }

          await tx.execute(
            `
              UPDATE food_entries
              SET dirty = 0
              WHERE id = ? AND updated_at = ?
            `,
            [row.id, row.updatedAt],
          );
        }

        if (dirtySettings && payload?.acceptedSettings) {
          await tx.execute(
            `
              UPDATE user_settings
              SET dirty = 0
              WHERE id = ? AND updated_at = ?
            `,
            [USER_SETTINGS_ROW_ID, dirtySettings.updatedAt],
          );
        }
      });

      if ((payload?.acceptedFoodEntryIds?.length ?? 0) > 0 || payload?.acceptedSettings) {
        this.bumpRevision();
      }
    } catch {
      return;
    } finally {
      this.syncInFlight = false;
      if (this.syncQueued) {
        this.syncQueued = false;
        this.scheduleSync(0);
      }
    }
  }

  async updateSocialProfile(displayName?: string): Promise<SocialOverview> {
    return this.postSocialOverview("/social/profile", { displayName });
  }

  async getSocialOverview(): Promise<SocialOverview> {
    return this.requestSocialOverview("/social/me");
  }

  async sendFriendRequest(friendCode: string): Promise<SocialOverview> {
    return this.postSocialOverview("/social/friend-requests", { friendCode });
  }

  async acceptFriendRequest(requestId: string): Promise<SocialOverview> {
    return this.postSocialOverview("/social/friend-requests/accept", { requestId });
  }

  async ignoreFriendRequest(requestId: string): Promise<SocialOverview> {
    return this.postSocialOverview("/social/friend-requests/ignore", { requestId });
  }

  async removeFriend(friendUserId: string): Promise<SocialOverview> {
    return this.requestSocialOverview(`/social/friends/${encodeURIComponent(friendUserId)}`, {
      method: "DELETE",
    });
  }

  async getFriendDailySummaries(dateKey: string): Promise<FriendDailySummary[]> {
    return FriendDailySummariesResponseSchema.parse(
      await this.requestBackend<unknown>(`/social/daily-summaries?dateKey=${encodeURIComponent(dateKey)}`),
    ).summaries;
  }

  async getFriendDailyDay(friendUserId: string, dateKey: string): Promise<FriendDailyDayResponse> {
    return FriendDailyDayResponseSchema.parse(
      await this.requestBackend<unknown>(
        `/social/friends/${encodeURIComponent(friendUserId)}/day?dateKey=${encodeURIComponent(dateKey)}`,
      ),
    );
  }

  private getDb(): DB {
    invariant(this.db, "Database is not initialized");
    return this.db;
  }

  private async requestSocialOverview(path: string, options?: BackendRequestOptions): Promise<SocialOverview> {
    return SocialOverviewSchema.parse(await this.requestBackend<unknown>(path, options));
  }

  private postSocialOverview(path: string, body: Record<string, unknown>): Promise<SocialOverview> {
    return this.requestSocialOverview(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async requestBackend<T>(
    path: string,
    options: BackendRequestOptions = {},
  ): Promise<T> {
    const token = this.activeUserId && this.tokenProvider ? await this.tokenProvider() : null;
    if (!token) {
      throw new Error("Not signed in");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    };

    const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
      ...options,
      headers,
    }).catch(() => {
      throw new Error("Network request failed");
    });

    const payload = await fetchJson<T | { error?: string }>(response);

    if (!response.ok) {
      throw new Error(parseBackendError(payload, "Request failed"));
    }

    if (!payload) {
      throw new Error("Invalid backend response");
    }

    return payload as T;
  }

  private async withTransaction(
    callback: (tx: Transaction | DB) => Promise<void>,
  ): Promise<void> {
    await this.initialize();
    await this.getDb().transaction(async (tx) => {
      await callback(tx);
    });
  }

  private async getMeta(key: string): Promise<string | null> {
    await this.initialize();
    const result = await this.getDb().execute(
      "SELECT value FROM meta WHERE key = ? LIMIT 1",
      [key],
    );

    return result.rows[0]?.value && typeof result.rows[0].value === "string"
      ? result.rows[0].value
      : null;
  }

  private async ensureDefaultSettingsRow(tx: Transaction | DB): Promise<void> {
    const payload = JSON.stringify(DEFAULT_USER_SETTINGS);

    await tx.execute(
      `
        INSERT OR IGNORE INTO user_settings (id, payload_json, updated_at, dirty)
        VALUES (?, ?, 0, 0)
      `,
      [USER_SETTINGS_ROW_ID, payload],
    );
  }

  private async getNextSortIndex(dateKey: string, meal: Meal): Promise<number> {
    await this.initialize();
    const result = await this.getDb().execute(
      `
        SELECT COALESCE(MAX(CAST(json_extract(payload_json, '$.sortIndex') AS REAL)), -1) AS max_sort_index
        FROM food_entries
        WHERE deleted_at IS NULL
          AND json_extract(payload_json, '$.dateKey') = ?
          AND json_extract(payload_json, '$.meal') = ?
      `,
      [dateKey, meal],
    );

    const maxSortIndex = result.rows[0]?.max_sort_index;
    return typeof maxSortIndex === "number" ? maxSortIndex + 1 : 0;
  }

  private async getFoodEntryRowById(id: string): Promise<FoodEntryRecord | null> {
    await this.initialize();
    const result = await this.getDb().execute(
      `
        SELECT id, payload_json, updated_at, deleted_at, dirty
        FROM food_entries
        WHERE id = ?
        LIMIT 1
      `,
      [id],
    );

    return result.rows[0] ? parseFoodEntryRow(result.rows[0] as SqlRow) : null;
  }

  private async getFoodEntryRowsByIds(ids: string[]): Promise<Map<string, FoodEntryRecord>> {
    await this.initialize();
    if (ids.length === 0) {
      return new Map();
    }

    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const result = await this.getDb().execute(
      `
        SELECT id, payload_json, updated_at, deleted_at, dirty
        FROM food_entries
        WHERE id IN (${placeholders})
      `,
      uniqueIds,
    );

    return new Map(
      result.rows.map((row) => {
        const parsed = parseFoodEntryRow(row as SqlRow);
        return [parsed.id, parsed] as const;
      }),
    );
  }

  private async getDirtyFoodEntryRows(): Promise<FoodEntryRecord[]> {
    await this.initialize();
    const result = await this.getDb().execute(
      `
        SELECT id, payload_json, updated_at, deleted_at, dirty
        FROM food_entries
        WHERE dirty = 1
        ORDER BY updated_at ASC, id ASC
      `,
    );

    return result.rows.map((row) => parseFoodEntryRow(row as SqlRow));
  }

  private async getUserSettingsRow(): Promise<UserSettingsRecord | null> {
    await this.initialize();
    const result = await this.getDb().execute(
      `
        SELECT id, payload_json, updated_at, dirty
        FROM user_settings
        WHERE id = ?
        LIMIT 1
      `,
      [USER_SETTINGS_ROW_ID],
    );

    return result.rows[0] ? parseUserSettingsRow(result.rows[0] as SqlRow) : null;
  }

  private async getDirtySettingsRow(): Promise<UserSettingsRecord | null> {
    await this.initialize();
    const result = await this.getDb().execute(
      `
        SELECT id, payload_json, updated_at, dirty
        FROM user_settings
        WHERE id = ? AND dirty = 1
        LIMIT 1
      `,
      [USER_SETTINGS_ROW_ID],
    );

    return result.rows[0] ? parseUserSettingsRow(result.rows[0] as SqlRow) : null;
  }

  private bumpRevision(): void {
    this.revision += 1;
    this.listeners.forEach((listener) => {
      listener();
    });
  }
}

export const localDataStore = new LocalDataStore();
