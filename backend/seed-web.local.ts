/**
 * Local-only, idempotent seed for web-preview.sh.
 *
 * The fixed accounts and password are disposable preview credentials. On a
 * normal run this exits as soon as the primary account exists, preserving any
 * edits made in the preview. WEB_PREVIEW_RESET=1 removes only these three
 * fixed preview users and recreates them.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { createDemo, shiftDate, dateKey } from "./web/model";
import { demoFriendDay } from "./web/friends";
import { auth } from "./src/auth";
import { db } from "./src/db";
import {
  account,
  friendships,
  session,
  socialProfiles,
  user,
  userFoodEntries,
  userRecipes,
  userSettings,
} from "./src/db/schema";

const PREVIEW_USERS = [
  {
    id: "web_preview_primary",
    email: "preview@caloric.local",
    name: "Taylor Morgan",
    code: "TAYLOR",
  },
  {
    id: "web_preview_alex",
    email: "alex@caloric.local",
    name: "Alex Rivera",
    code: "ALEXPR",
  },
  {
    id: "web_preview_june",
    email: "june@caloric.local",
    name: "June Park",
    code: "JUNEPR",
  },
] as const;
const PASSWORD = "CaloricPreview123!";
const IDS = PREVIEW_USERS.map(({ id }) => id);

function assertPreviewDatabase(): void {
  const url = new URL(process.env.DATABASE_URL || "");
  if (
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    url.pathname !== "/caloric_web_preview"
  ) {
    throw new Error(
      "Refusing to seed: DATABASE_URL must be the loopback caloric_web_preview database",
    );
  }
}

async function resetPreviewData(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(friendships)
      .where(
        or(
          inArray(friendships.userAId, IDS),
          inArray(friendships.userBId, IDS),
        ),
      );
    await tx
      .delete(userFoodEntries)
      .where(inArray(userFoodEntries.userId, IDS));
    await tx.delete(userRecipes).where(inArray(userRecipes.userId, IDS));
    await tx.delete(userSettings).where(inArray(userSettings.userId, IDS));
    await tx.delete(socialProfiles).where(inArray(socialProfiles.userId, IDS));
    await tx.delete(session).where(inArray(session.userId, IDS));
    await tx.delete(account).where(inArray(account.userId, IDS));
    await tx.delete(user).where(inArray(user.id, IDS));
  });
}

async function main(): Promise<void> {
  assertPreviewDatabase();
  if (process.env.WEB_PREVIEW_RESET === "1") await resetPreviewData();

  const alreadySeeded = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, PREVIEW_USERS[0].id))
    .limit(1);
  if (alreadySeeded.length) {
    console.log(
      "Web preview already seeded; preserving local edits (set WEB_PREVIEW_RESET=1 for an explicit preview-only reset).",
    );
    return;
  }

  const now = new Date();
  const passwordHash = await (await auth.$context).password.hash(PASSWORD);
  const today = dateKey();
  const primary = createDemo(today);

  await db.transaction(async (tx) => {
    for (const previewUser of PREVIEW_USERS) {
      await tx.insert(user).values({
        id: previewUser.id,
        email: previewUser.email,
        name: previewUser.name,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(account).values({
        id: `web_preview_account_${previewUser.id}`,
        userId: previewUser.id,
        accountId: previewUser.id,
        providerId: "credential",
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(socialProfiles).values({
        userId: previewUser.id,
        displayName: previewUser.name,
        friendCode: previewUser.code,
        createdAt: now,
        updatedAt: now,
      });
    }

    const settings = [
      primary.settings,
      {
        calorieGoal: 2200,
        macroProteinPct: 30,
        macroCarbsPct: 40,
        macroFatPct: 30,
      },
      {
        calorieGoal: 2000,
        macroProteinPct: 25,
        macroCarbsPct: 50,
        macroFatPct: 25,
      },
    ];
    for (let index = 0; index < PREVIEW_USERS.length; index++) {
      await tx
        .insert(userSettings)
        .values({
          userId: PREVIEW_USERS[index].id,
          data: settings[index],
          updatedAt: now,
        });
    }

    for (const row of primary.entries) {
      await tx
        .insert(userFoodEntries)
        .values({
          userId: PREVIEW_USERS[0].id,
          id: row.id,
          data: row.data,
          // Fixtures use noon for calendar dates. A morning setup must not
          // create future sync timestamps that reject edits as stale.
          updatedAt: new Date(Math.min(row.updatedAt, now.getTime())),
        });
    }
    for (const row of primary.recipes) {
      await tx
        .insert(userRecipes)
        .values({
          userId: PREVIEW_USERS[0].id,
          id: row.id,
          data: row.data,
          updatedAt: new Date(row.updatedAt),
        });
    }

    for (
      let friendIndex = 1;
      friendIndex < PREVIEW_USERS.length;
      friendIndex++
    ) {
      for (let offset = -6; offset <= 0; offset++) {
        const day = shiftDate(today, offset);
        const fixtureId = friendIndex === 1 ? "demo_alex" : "demo_june";
        const fixture = demoFriendDay(fixtureId, day);
        for (const [entryIndex, entry] of fixture.entries.entries()) {
          const { id: _fixtureId, updatedAt, ...data } = entry;
          await tx.insert(userFoodEntries).values({
            userId: PREVIEW_USERS[friendIndex].id,
            id: `web_preview_${friendIndex}_${offset}_${entryIndex}`,
            data,
            updatedAt: new Date(Math.min(updatedAt, now.getTime())),
          });
        }
      }
      const recipe = primary.recipes[friendIndex - 1];
      await tx
        .insert(userRecipes)
        .values({
          userId: PREVIEW_USERS[friendIndex].id,
          id: `friend_${recipe.id}`,
          data: recipe.data,
          updatedAt: now,
        });
    }

    for (
      let friendIndex = 1;
      friendIndex < PREVIEW_USERS.length;
      friendIndex++
    ) {
      const friendId = PREVIEW_USERS[friendIndex].id;
      await tx.insert(friendships).values({
        id: `web_preview_friendship_${friendIndex}`,
        requesterUserId: PREVIEW_USERS[0].id,
        recipientUserId: friendId,
        userAId:
          PREVIEW_USERS[0].id < friendId ? PREVIEW_USERS[0].id : friendId,
        userBId:
          PREVIEW_USERS[0].id < friendId ? friendId : PREVIEW_USERS[0].id,
        status: "accepted",
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  console.log(
    "Seeded disposable local preview account plus two accepted friends and seven days of journals.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
