// One-time migration: recreate the existing (formerly Clerk) users as Better
// Auth accounts, PRESERVING their user ids. Because every user-scoped table
// (user_food_entries, user_settings, social_profiles, friendships, ai_sessions)
// is keyed on that id, seeding `user`/`account` with the same id means all
// existing data keeps resolving with zero rewrite.
//
// We only have a couple of users, so this is intentionally manual.
//
// Usage:
//   1. Run migrations first:   pnpm run db:migrate
//   2. Discover existing ids:  bun migrate-clerk-users.local.ts        (lists them)
//   3. Create the accounts:    MIGRATE_USERS='[{"id":"user_abc","email":"a@b.com","password":"...","name":"Mati"}]' \
//                                bun migrate-clerk-users.local.ts
//
// Re-running is safe: existing users are updated in place, and a credential
// account is only created once per user.
import { and, eq } from "drizzle-orm";
import { auth } from "./src/auth";
import { db } from "./src/db";
import {
  account,
  aiSessions,
  socialProfiles,
  user,
  userFoodEntries,
  userSettings,
} from "./src/db/schema";

type MigrateUser = {
  id: string;
  email: string;
  password: string;
  name?: string;
};

function parseMigrateUsers(): MigrateUser[] {
  const raw = process.env.MIGRATE_USERS;
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MIGRATE_USERS must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("MIGRATE_USERS must be a JSON array");
  }

  return parsed.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as MigrateUser).id !== "string" ||
      typeof (entry as MigrateUser).email !== "string" ||
      typeof (entry as MigrateUser).password !== "string"
    ) {
      throw new Error(`MIGRATE_USERS[${index}] must have string id, email, password`);
    }
    return entry as MigrateUser;
  });
}

async function listExistingUserIds(): Promise<Map<string, string[]>> {
  const sources: { table: string; ids: { userId: string }[] }[] = [
    { table: "user_settings", ids: await db.select({ userId: userSettings.userId }).from(userSettings) },
    { table: "social_profiles", ids: await db.select({ userId: socialProfiles.userId }).from(socialProfiles) },
    { table: "user_food_entries", ids: await db.selectDistinct({ userId: userFoodEntries.userId }).from(userFoodEntries) },
    { table: "ai_sessions", ids: await db.selectDistinct({ userId: aiSessions.userId }).from(aiSessions) },
  ];

  const byId = new Map<string, string[]>();
  for (const { table, ids } of sources) {
    for (const { userId } of ids) {
      const tables = byId.get(userId) ?? [];
      if (!tables.includes(table)) {
        tables.push(table);
      }
      byId.set(userId, tables);
    }
  }
  return byId;
}

async function upsertAuthUser(entry: MigrateUser, passwordHash: string): Promise<void> {
  const now = new Date();
  const name = entry.name?.trim() || entry.email.split("@")[0] || "Caloric user";

  await db
    .insert(user)
    .values({
      id: entry.id,
      name,
      email: entry.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: user.id,
      set: { name, email: entry.email, emailVerified: true, updatedAt: now },
    });

  const existingCredential = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, entry.id), eq(account.providerId, "credential")))
    .limit(1);

  if (existingCredential[0]) {
    await db
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
      .where(eq(account.id, existingCredential[0].id));
  } else {
    await db.insert(account).values({
      id: crypto.randomUUID(),
      userId: entry.id,
      accountId: entry.id,
      providerId: "credential",
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function main(): Promise<void> {
  const existing = await listExistingUserIds();
  console.log(`\nExisting user ids found in the database (${existing.size}):`);
  if (existing.size === 0) {
    console.log("  (none — a fresh database)");
  } else {
    for (const [userId, tables] of existing) {
      console.log(`  ${userId}   (in: ${tables.join(", ")})`);
    }
  }

  const users = parseMigrateUsers();
  if (users.length === 0) {
    console.log(
      "\nNo MIGRATE_USERS provided. Re-run with MIGRATE_USERS set to create Better Auth\n" +
        "accounts for the ids above (see the header of this file for the exact format).",
    );
    return;
  }

  const ctx = await auth.$context;

  for (const entry of users) {
    if (existing.size > 0 && !existing.has(entry.id)) {
      console.warn(
        `\n! ${entry.id} was not found among existing data ids. Creating it anyway, ` +
          "but double-check the id matches the old Clerk user id.",
      );
    }

    const passwordHash = await ctx.password.hash(entry.password);
    await upsertAuthUser(entry, passwordHash);
    console.log(`\n✓ Migrated ${entry.email} -> id ${entry.id} (password + email-code login enabled)`);
  }

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
