import assert from "node:assert/strict";
import { chromium, type Route } from "playwright";
import { applyChanges, createDemo, dateKey, type Food } from "./model";
import { demoFriendDay } from "./friends";

// Deterministic transport tests for the real client. No requests reach external
// food/AI providers or write to the preview database.
const url = process.env.CALORIC_WEB_URL || "http://localhost:8787";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
  locale: "en-US",
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let user: string | null = null;
let snapshot = createDemo(dateKey());
let failBootstrap = true;
let failWrite = false;
let displayName = "Query tester";
let profileWrites = 0;
let summaryReads = 0;
let assistantSessions = 0;
let assistantTurns = 0;
const searches: string[] = [];
let slowSearch!: Route;
let receiveSlow!: () => void;
let receiveNextPage!: () => void;
let finishNextPage!: () => void;
let failedNextPage = false;
const food = (id: string, name: string, calories: number): Food => ({
  id,
  name,
  serving: "1 serving",
  nutrition: { calories },
});
const overview = () => ({
  profile: { userId: user!, displayName, friendCode: "TEST-123" },
  friends: [{ userId: "demo_alex", displayName: "Alex Rivera", since: 1 }],
  incomingRequests: [],
  outgoingRequests: [],
});
await page.route("**/*", async (route) => {
  const request = route.request();
  const target = new URL(request.url());
  const path = target.pathname;
  if (path === "/api/auth/get-session")
    return route.fulfill({ json: user ? { user: { id: user } } : null });
  if (path === "/api/auth/sign-in/email") {
    user = request.postDataJSON().email.startsWith("other")
      ? "account-b"
      : "account-a";
    return route.fulfill({ json: {} });
  }
  if (path === "/api/auth/sign-out") {
    user = null;
    return route.fulfill({ json: {} });
  }
  if (path === "/sync/bootstrap") {
    if (failBootstrap) {
      failBootstrap = false;
      return route.fulfill({
        status: 503,
        json: { message: "Bootstrap unavailable" },
      });
    }
    return route.fulfill({
      json: {
        foodEntries: user === "account-a" ? snapshot.entries : [],
        recipes: user === "account-a" ? snapshot.recipes : [],
        settings: { id: "settings", data: snapshot.settings, updatedAt: 1 },
      },
    });
  }
  if (path === "/sync/push") {
    if (failWrite)
      return route.fulfill({
        status: 503,
        json: { message: "Write unavailable" },
      });
    const data = request.postDataJSON();
    snapshot = applyChanges(snapshot, {
      entries: data.foodEntries,
      recipes: data.recipes,
      settings: data.settings?.data,
    });
    return route.fulfill({
      json: {
        acceptedFoodEntryIds: data.foodEntries.map((row: any) => row.id),
        acceptedRecipeIds: data.recipes.map((row: any) => row.id),
        acceptedSettings: Boolean(data.settings),
      },
    });
  }
  if (path === "/social/daily-summaries") {
    summaryReads++;
    return route.fulfill({
      json: {
        summaries:
          user === "account-a"
            ? [
                demoFriendDay("demo_alex", target.searchParams.get("dateKey")!)
                  .summary,
              ]
            : [],
      },
    });
  }
  if (path === "/social/me") return route.fulfill({ json: overview() });
  if (path === "/social/profile") {
    profileWrites++;
    displayName = request.postDataJSON().displayName;
    return route.fulfill({ json: overview() });
  }
  if (path.startsWith("/social/friends/"))
    return route.fulfill({
      json: demoFriendDay("demo_alex", target.searchParams.get("dateKey")!),
    });
  if (path === "/search") {
    searches.push(target.search);
    if (target.searchParams.get("query") === "slow") {
      slowSearch = route;
      receiveSlow();
      return;
    }
    const provider = target.searchParams.get("provider");
    const query = target.searchParams.get("query");
    const requestedPage = Number(target.searchParams.get("page"));
    if (query === "cap" || query === "empty") {
      return route.fulfill({ json: { foods: [], hasMore: query === "cap" } });
    }
    if (query === "retry" && requestedPage === 2 && !failedNextPage) {
      failedNextPage = true;
      return route.fulfill({ status: 503, json: { message: "Page unavailable" } });
    }
    if (query === "oats" && provider === "mfp" && requestedPage === 2) {
      receiveNextPage();
      await new Promise<void>((resolve) => { finishNextPage = resolve; });
    }
    const firstIndex = (requestedPage - 1) * 20 + 1;
    const rows = Array.from({ length: query === "retry" ? 1 : 20 }, (_, index) =>
      food(`${provider}-${firstIndex + index}`, `${provider === "mfp" ? "MFP" : "OFF"} oats ${firstIndex + index}`, requestedPage * 111),
    );
    // Upstream pages can overlap; the first row must remain stable and unique.
    if (requestedPage === 2) rows.unshift(food(`${provider}-duplicate`, `${provider === "mfp" ? "MFP" : "OFF"} duplicate`, 999));
    for (const row of rows) row.canonicalKey = row.id.endsWith("duplicate") ? `${provider}-1` : row.id;
    return route.fulfill({
      json: {
        foods: rows,
        hasMore: requestedPage < (query === "retry" ? 2 : 3),
      },
    });
  }
  if (path === "/ai/session") {
    assistantSessions++;
    return route.fulfill({ json: { sessionId: "query-test-session" } });
  }
  if (path === "/ai/turn") {
    assistantTurns++;
    const action = request.postDataJSON().action;
    if (action.type === "approval") return route.fulfill({ json: {} });
    const events = [
      {
        type: "event",
        seq: 0,
        event: { kind: "assistant", text: "Here is your food." },
      },
      {
        type: "event",
        seq: 1,
        event: {
          kind: "approval",
          toolCallId: "approval-test",
          suggestions: [
            {
              suggestionId: "query-test-food",
              food: food("ai-food", "Assistant food", 200),
              portion: 0.5,
              meal: "lunch",
            },
          ],
        },
      },
      { type: "status", seq: 2, status: "ready" },
    ];
    return route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  }
  if (/^\/(api|sync|social|search|ai)(\/|$)/.test(path))
    throw new Error(`Unhandled API request: ${path}`);
  return route.continue();
});
const close = async () => {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.waitForTimeout(150);
};
const calories = (value: string) =>
  page.waitForFunction(
    (value) =>
      document.querySelector('[data-testid="day-calories"]')?.textContent ===
      value,
    value,
  );
async function signIn(email: string) {
  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("TestPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
try {
  await page.goto(url);
  await signIn("test@example.com");
  await page.getByText("Bootstrap unavailable").waitFor();
  await page.getByRole("button", { name: "Try again" }).click();
  await calories("1,256");

  await page.getByRole("button", { name: "Open Alex Rivera's day" }).click();
  await page
    .getByRole("dialog")
    .getByText("Grilled chicken breast")
    .waitFor();
  await close();
  await page.getByRole("button", { name: "Manage friends" }).click();
  await page.getByLabel("Display name").fill("Renamed tester");
  const beforeSummary = summaryReads;
  const summaryRefresh = page.waitForResponse("**/social/daily-summaries?*");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Profile saved.").waitFor();
  await summaryRefresh;
  assert.equal(profileWrites, 1);
  assert(summaryReads > beforeSummary);
  await close();
  await page.getByRole("button", { name: "Manage friends" }).click();
  assert.equal(
    await page.getByLabel("Display name").inputValue(),
    "Renamed tester",
  );
  await close();

  await page
    .getByRole("button", { name: "Add food to Breakfast", exact: true })
    .click();
  const search = page.getByRole("searchbox", { name: "Search foods" });
  const drawerHeight = (await page.getByRole("dialog").boundingBox())!.height;
  const nextPage = new Promise<void>((resolve) => { receiveNextPage = resolve; });
  const slow = new Promise<void>((resolve) => {
    receiveSlow = resolve;
  });
  await search.fill("slow");
  await slow;
  assert.equal(await page.getByLabel("Food source").inputValue(), "mfp");
  assert.equal((await page.getByRole("dialog").boundingBox())!.height, drawerHeight);
  await search.fill("oats");
  await page.getByRole("button", { name: /^MFP oats 1\b/ }).waitFor();
  await slowSearch
    .fulfill({
      json: { foods: [food("stale", "Stale result", 999)], hasMore: false },
    })
    .catch(() => {});
  assert.equal(
    await page.getByRole("button", { name: /^Stale result/ }).count(),
    0,
  );
  assert(searches.every((value) => new URLSearchParams(value).get("provider") === "mfp"));
  await page.getByRole("button", { name: /^MFP oats 20\b/ }).scrollIntoViewIfNeeded();
  await nextPage;
  await page.getByText("Loading more foods…", { exact: true }).waitFor();
  assert.equal(await page.locator(".food-result").count(), 20);
  const scrollBefore = await page.locator(".sheet-content").evaluate((element) => element.scrollTop);
  assert.equal((await page.getByRole("dialog").boundingBox())!.height, drawerHeight);
  finishNextPage();
  await page.getByRole("button", { name: /^MFP oats 21\b/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^MFP oats 1\b/ }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /duplicate/ }).count(), 0);
  assert.equal(await page.locator(".sheet-content").evaluate((element) => element.scrollTop), scrollBefore);
  await page.getByRole("button", { name: /^MFP oats 40\b/ }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: /^MFP oats 41\b/ }).waitFor();
  assert.equal(await page.locator(".food-result").count(), 60);
  assert.deepEqual(searches.filter((value) => new URLSearchParams(value).get("query") === "oats").map((value) => new URLSearchParams(value).get("page")), ["1", "2", "3"]);
  assert.equal(await page.getByRole("button", { name: "Load more foods" }).count(), 0);
  assert.equal((await page.getByRole("dialog").boundingBox())!.height, drawerHeight);
  await page.getByLabel("Food source").selectOption("openfoodfacts");
  await page.getByRole("button", { name: /^OFF oats 1\b/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^MFP oats/ }).count(), 0);
  const beforeCachedSearch = searches.length;
  await page.getByLabel("Food source").selectOption("mfp");
  await page.getByRole("button", { name: /^MFP oats 41\b/ }).waitFor();
  assert.equal(searches.length, beforeCachedSearch);
  await page.getByRole("button", { name: /^MFP oats 1\b/ }).click();
  await page.getByRole("button", { name: "Back to search" }).waitFor();
  await page.waitForFunction((height) => document.querySelector(".sheet")!.getBoundingClientRect().height < height - 80, drawerHeight);
  await page.getByRole("button", { name: "Back to search" }).click();
  await page.waitForFunction((height) => document.querySelector(".sheet")!.getBoundingClientRect().height === height, drawerHeight);
  await close();

  // Short pages, empty results and failures must keep a phone-sized drawer stable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Add food to Breakfast", exact: true }).click();
  const phoneHeight = (await page.getByRole("dialog").boundingBox())!.height;
  await search.fill("retry");
  await page.getByRole("alert").filter({ hasText: "Page unavailable" }).waitFor();
  const failedSearchCount = searches.length;
  await page.waitForTimeout(400);
  assert.equal(searches.length, failedSearchCount, "Failed pages must not loop automatic retries");
  assert.equal(await page.getByRole("button", { name: /^MFP oats 1\b/ }).count(), 1);
  assert.equal((await page.getByRole("dialog").boundingBox())!.height, phoneHeight);
  await page.getByRole("button", { name: "Retry loading more foods" }).click();
  await page.getByRole("button", { name: /^MFP oats 21\b/ }).waitFor();
  await search.fill("empty");
  await page.getByRole("heading", { name: "No foods found" }).waitFor();
  assert.equal((await page.getByRole("dialog").boundingBox())!.height, phoneHeight);
  await search.fill("cap");
  await page.waitForFunction(() => document.querySelector(".result-heading span")?.textContent === "0 foods" && !document.querySelector(".food-pagination button"));
  await page.waitForTimeout(400);
  assert.equal(searches.filter((value) => new URLSearchParams(value).get("query") === "cap").length, 10);
  assert.equal((await page.getByRole("dialog").boundingBox())!.height, phoneHeight);
  await close();
  await page.setViewportSize({ width: 1280, height: 900 });

  await page
    .getByRole("button", { name: "Edit Greek yogurt", exact: true })
    .click();
  await page.getByLabel("Servings", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save changes" }).click();
  await calories("1,376");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  failWrite = true;
  await page
    .getByRole("button", { name: "Edit Greek yogurt", exact: true })
    .click();
  await page.getByLabel("Servings", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Write unavailable").waitFor();
  assert.equal(
    await page.locator('[data-testid="day-calories"]').first().textContent(),
    "1,376",
  );
  await close();
  failWrite = false;

  await page
    .getByRole("button", { name: "Message the food assistant" })
    .click();
  await page.getByLabel("Message Caloric").fill("Add some food");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Here is your food.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add food", exact: true }).click();
  await page.getByText("Added to Lunch", { exact: true }).waitFor();
  await calories("1,476");
  assert.equal(assistantSessions, 1);
  assert.equal(assistantTurns, 2);
  await close();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Calorie goal").fill("2400");
  await page.getByRole("button", { name: "Save goals" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(snapshot.settings.calorieGoal, 2400);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).waitFor();
  // Include a delayed persister flush: it must not resurrect account A's data.
  await page.waitForTimeout(1200);
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("caloric.web.queries") || "null")
          ?.clientState.queries.length ?? 0,
    ),
    0,
  );
  await signIn("other@example.com");
  await calories("0");
  await page.getByText("Add friends in Settings.").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Open Alex Rivera's day" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Edit Greek yogurt" }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: query browser checks: auth/bootstrap retry, friend-day queries, social invalidation, MFP default, automatic three-page search/deduplication/provider cache, stale search cancellation, desktop/phone drawer height, compact food details, failed-page retry/page cap, journal success/failure, assistant SSE/approval mutations, goals and sign-out/account isolation.",
  );
} catch (error) {
  console.error("Browser state at failure:", await page.locator("body").innerText());
  console.error("Search requests:", searches);
  throw error;
} finally {
  await browser.close();
}
