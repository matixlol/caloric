import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  webkit,
  devices,
  type Page,
  type Locator,
  type Route,
} from "playwright";
import { createDemo, dateKey } from "./model";

// Real auth + sync against the isolated preview. Never modify the seeded
// account: writes go to a fresh test account, not a browser storage adapter.
const url = (process.env.CALORIC_WEB_URL || "http://localhost:8787").replace(
  /\/$/,
  "",
);
const host = new URL(url).hostname;
assert(
  ["localhost", "127.0.0.1"].includes(host) || host.endsWith(".onamp.dev"),
  "Use the isolated preview, not production",
);
const artifacts = process.env.CALORIC_SCREENSHOTS;
const engine = process.env.CALORIC_BROWSER === "webkit" ? webkit : chromium;
const browser = await engine.launch({
  executablePath: engine === chromium ? process.env.CHROMIUM_PATH : undefined,
});
if (artifacts) await mkdir(artifacts, { recursive: true });
const errors: string[] = [];
let assertions = 0;
function check(value: unknown, expected: unknown, message?: string) {
  assert.deepEqual(value, expected, message);
  assertions++;
}
async function close(page: Page) {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.waitForTimeout(150);
}
async function calories(page: Page, value: string) {
  await page.waitForFunction(
    (value) =>
      document.querySelector('[data-testid="day-calories"]')?.textContent ===
      value,
    value,
  );
}
async function shot(page: Page, name: string) {
  if (!artifacts) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${artifacts}/${name}.png` });
}
async function signIn(page: Page, email: string) {
  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("CaloricPreview123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
}
async function friendLoadingChecks(page: Page) {
  const pattern = "**/social/daily-summaries?*";
  const card = page.locator(".friends-card");
  const rows = card.locator("button.friend-summary");
  const skeletons = card.locator(".friend-skeleton");
  const cacheKey = "caloric.web.queries";
  const response = await page.request.get(
    `${url}/social/daily-summaries?dateKey=${dateKey()}`,
  );
  const today = await response.json();
  check(today.summaries.length, 2);
  // Every request is held until the assertions have inspected its loading state.
  let receive!: (route: Route) => void;
  const nextRequest = () =>
    new Promise<Route>((resolve) => {
      receive = resolve;
    });
  await page.route(pattern, (route) => receive(route));
  const height = async () => (await card.boundingBox())!.height;
  const noEmptyState = async () =>
    check(await card.getByText("Add friends in Settings.").count(), 0);
  const persisted = (day: string, calories: number) =>
    page.waitForFunction(
      ({ key, day, calories }) =>
        JSON.parse(
          localStorage.getItem(key) || "null",
        )?.clientState.queries.some(
          (query: any) =>
            query.queryKey[2] === "summaries" &&
            query.queryKey[3] === day &&
            query.state.data?.[0]?.calories === calories,
        ),
      { key: cacheKey, day, calories },
    );
  try {
    // A cold load is unknown, not an empty friend list.
    await page.evaluate((key) => localStorage.removeItem(key), cacheKey);
    let pending = nextRequest();
    await page.reload();
    let request = await pending;
    await skeletons.first().waitFor();
    check(await skeletons.count(), 1);
    await noEmptyState();
    await request.fulfill({ json: today });
    await rows.nth(1).waitFor();
    const loadedHeight = await height();
    const original = await rows.allTextContents();
    await persisted(dateKey(), today.summaries[0].calories);

    // Reload keeps the actual summaries, even when the refresh fails.
    pending = nextRequest();
    await page.reload();
    request = await pending;
    await rows.nth(1).waitFor();
    check(await rows.allTextContents(), original);
    check(await height(), loadedHeight);
    await request.fulfill({ status: 503, json: { message: "Unavailable" } });
    await card.getByRole("button", { name: "Retry" }).waitFor();
    check(await rows.allTextContents(), original);
    await shot(page, "caloric-friends-refresh-error");
    pending = nextRequest();
    await card.getByRole("button", { name: "Retry" }).click();
    request = await pending;
    check(await rows.allTextContents(), original);
    await request.fulfill({ json: today });

    // An unseen date uses the remembered count, never another date's calories.
    pending = nextRequest();
    await page
      .getByRole("button", { name: "Previous day", exact: true })
      .click();
    request = await pending;
    await skeletons.nth(1).waitFor();
    check(await skeletons.count(), 2);
    check(await rows.count(), 0);
    check(
      await card.getByRole("button", { name: "Manage friends" }).textContent(),
      "2",
    );
    check(await card.getAttribute("aria-busy"), "true");
    check(await height(), loadedHeight);
    await noEmptyState();
    await page.evaluate(() => scrollTo(0, 0));
    await shot(page, "caloric-friends-loading");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await shot(page, "caloric-friends-loading-dark");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    const yesterday = {
      summaries: today.summaries.map((friend: any, i: number) => ({
        ...friend,
        dateKey: new URL(request.request().url()).searchParams.get("dateKey"),
        calories: i ? 765 : 321,
      })),
    };
    await request.fulfill({ json: yesterday });
    await rows.first().locator("b").filter({ hasText: "321" }).waitFor();
    check(await height(), loadedHeight);
    await persisted(yesterday.summaries[0].dateKey, 321);

    // On a new day after reload, persisted count alone still reserves the space.
    await page.evaluate(
      ({ key, day }) => {
        const cache = JSON.parse(localStorage.getItem(key)!);
        cache.clientState.queries = cache.clientState.queries.filter(
          (query: any) => query.queryKey[3] !== day,
        );
        localStorage.setItem(key, JSON.stringify(cache));
      },
      { key: cacheKey, day: dateKey() },
    );
    pending = nextRequest();
    await page.reload();
    request = await pending;
    await skeletons.nth(1).waitFor();
    check(await skeletons.count(), 2);
    check(await height(), loadedHeight);
    await noEmptyState();
    await request.fulfill({ json: today });
    await rows.nth(1).waitFor();
    pending = nextRequest();
    await page
      .getByRole("button", { name: "Previous day", exact: true })
      .click();
    request = await pending;
    check((await rows.first().locator("b").textContent())?.trim(), "321");
    await request.fulfill({ json: yesterday });

    // Returning to a cached date must select that date's values immediately.
    pending = nextRequest();
    await page
      .getByRole("button", { name: "Back to today", exact: true })
      .click();
    request = await pending;
    check(await rows.allTextContents(), original);
    check(await skeletons.count(), 0);
    await request.fulfill({ json: today });

    // A pending request for a different day cannot replace today's cache.
    pending = nextRequest();
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    const abandoned = await pending;
    await skeletons.nth(1).waitFor();
    pending = nextRequest();
    await page
      .getByRole("button", { name: "Back to today", exact: true })
      .click();
    request = await pending;
    await abandoned.fulfill({ json: { summaries: [] } }).catch(() => {});
    await request.fulfill({ json: today });
    check(await rows.allTextContents(), original);

    // A confirmed empty response is the only source of the empty-state message.
    pending = nextRequest();
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    request = await pending;
    await noEmptyState();
    await request.fulfill({ json: { summaries: [] } });
    await card.getByText("Add friends in Settings.").waitFor();
    const emptyHeight = await height();
    pending = nextRequest();
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    request = await pending;
    await card.getByText("Loading friends…").waitFor();
    check(await height(), emptyHeight);
    check(await skeletons.count(), 0);
    await noEmptyState();
    await request.fulfill({ json: { summaries: [] } });
    console.log(
      `Friends loading/cache checks passed; loaded and skeleton card height: ${loadedHeight}px.`,
    );
  } finally {
    await page.unroute(pattern);
    await page.evaluate((key) => localStorage.removeItem(key), cacheKey);
    await page.reload();
    await rows.nth(1).waitFor();
  }
}
async function saved(page: Page) {
  const response = await page.request.get(`${url}/sync/bootstrap`);
  check(response.status(), 200);
  return response.json();
}
async function gestures(page: Page) {
  // CDP touch generates real browser scrolling/pointercancel, not synthetic DOM events.
  const cdp =
    engine === chromium ? await page.context().newCDPSession(page) : null;
  const send = async (type: "start" | "move" | "end", x = 0, y = 0) => {
    if (cdp)
      await cdp.send("Input.dispatchTouchEvent", {
        type:
          type === "start"
            ? "touchStart"
            : type === "move"
              ? "touchMove"
              : "touchEnd",
        touchPoints: type === "end" ? [] : [{ x, y, id: 1 }],
      });
    else if (type === "start") {
      await page.mouse.move(x, y);
      await page.mouse.down();
    } else if (type === "move") await page.mouse.move(x, y);
    else await page.mouse.up();
  };
  return {
    send,
    dispose: async () => {
      await cdp?.detach();
    },
  };
}
async function point(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const rect = await locator.boundingBox();
  assert(rect);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
async function journalNames(page: Page, meal: string) {
  return page
    .getByRole("region", { name: meal, exact: true })
    .locator(".entry-button .row-main strong")
    .allTextContents();
}
async function addedVisible(page: Page, id: string) {
  await page.waitForFunction((id) => {
    const row = document.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    const dock = document
      .querySelector(".composer-dock")!
      .getBoundingClientRect();
    return rect.height > 0 && rect.top >= 0 && rect.bottom <= dock.top;
  }, id);
  // History/focus restoration must not undo the scroll after dismissal.
  await page.waitForTimeout(300);
  check(
    await page.locator(`[data-entry-id="${id}"]`).evaluate((row) => {
      const rect = row.getBoundingClientRect();
      return (
        rect.top >= 0 &&
        rect.bottom <=
          document.querySelector(".composer-dock")!.getBoundingClientRect().top
      );
    }),
    true,
  );
  check(
    await page
      .locator(".toast > span")
      .filter({ hasText: /added$/ })
      .count(),
    0,
  );
}
async function portionChecks(page: Page) {
  const before = await saved(page);
  const ids = new Set(before.foodEntries.map((row: any) => row.id));
  const gesture = await gestures(page);
  try {
    await page
      .getByRole("button", { name: "Add food to Dinner", exact: true })
      .tap();
    await page.getByRole("button", { name: "Recipes", exact: true }).tap();
    await page.getByRole("button", { name: /^My breakfast bowl/ }).tap();
    const button = page.getByRole("button", {
      name: "Add to Dinner",
      exact: true,
    });
    const hold = async () => {
      const start = await point(button);
      await gesture.send("start", start.x, start.y);
      await page.locator(".portion-popover").waitFor();
      return start;
    };
    // A stationary hold must cancel and never fall through to a normal Add click.
    await hold();
    await gesture.send("end");
    await page.locator(".portion-popover").waitFor({ state: "detached" });
    check(await page.getByRole("dialog").count(), 1);
    check((await saved(page)).foodEntries.length, ids.size);
    // Just below the iOS dead zone: dragging is active, but there is no portion.
    let start = await hold();
    await gesture.send("move", start.x, start.y - 53);
    await page.waitForTimeout(80);
    check(
      await page.locator(".portion-rail-card > strong").textContent(),
      "Slide up",
    );
    await gesture.send("end");
    await page.locator(".portion-popover").waitFor({ state: "detached" });
    check((await saved(page)).foodEntries.length, ids.size);
    // Escape cancels a valid selection without closing the food sheet.
    start = await hold();
    await gesture.send("move", start.x, start.y - 266.5);
    await page.locator(".portion-step.whole.selected").waitFor();
    check(
      (await page.locator(".portion-step.whole.selected i").boundingBox())!
        .height,
      40,
    );
    await shot(page, "caloric-native-portion-whole");
    await page.keyboard.press("Escape");
    await gesture.send("end");
    check(await page.getByRole("dialog").count(), 1);
    check((await saved(page)).foodEntries.length, ids.size);
    start = await hold();
    // Native weighted centers: 54px dead zone + 175px for 1¾ servings.
    await gesture.send("move", start.x, start.y - 229);
    await page.waitForFunction(
      () =>
        document.querySelector(".portion-rail-card > strong")?.textContent ===
        "1 3/4×",
    );
    await shot(page, "caloric-native-portion-drag");
    await gesture.send("end");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const recipeRows = (await saved(page)).foodEntries.filter(
      (row: any) => !ids.has(row.id),
    );
    check(recipeRows.length, 1); // Release and subsequent click must not double-add.
    check(recipeRows[0].data.portion, 1.75);
    check(recipeRows[0].data.recipeId, "demo_recipe_0");
    check(recipeRows[0].data.recipeItems.length, 3);
    await addedVisible(page, recipeRows[0].id);
    await calories(page, "2,630"); // 2005.25 + (120 + 57 + 180) × 1.75

    await page
      .getByRole("button", { name: "Add food to Lunch", exact: true })
      .tap();
    await page.getByRole("button", { name: /^Baked salmon/ }).tap();
    start = await point(
      page.getByRole("button", { name: "Add to Lunch", exact: true }),
    );
    await gesture.send("start", start.x, start.y);
    await page.locator(".portion-popover").waitFor();
    await gesture.send("move", start.x, start.y - 79);
    await page.waitForFunction(
      () =>
        document.querySelector(".portion-rail-card > strong")?.textContent ===
        "1/2×",
    );
    await gesture.send("end");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.reload();
    await calories(page, "2,785"); // 2630 + 309 × 0.5, rounded
    const foodRows = (await saved(page)).foodEntries.filter(
      (row: any) => !ids.has(row.id) && row.data.foodName === "Baked salmon",
    );
    check(foodRows.length, 1);
    check(foodRows[0].data.portion, 0.5);
    check(foodRows[0].data.meal, "lunch");
  } finally {
    await gesture.dispose();
  }
}
async function resizeChecks(page: Page) {
  const sampleOverlay = () =>
    page.evaluate(async () => {
      const frames: { y: number; opacity: number }[] = [];
      const deadline = performance.now() + 5000;
      let appearedAt: number | null = null;
      while (performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        const sheet = document.querySelector(".sheet");
        const backdrop = document.querySelector(".sheet-backdrop");
        if (sheet && backdrop) {
          appearedAt ??= performance.now();
          frames.push({
            y: new DOMMatrix(getComputedStyle(sheet).transform).m42,
            opacity: Number(getComputedStyle(backdrop).opacity),
          });
        }
        if (appearedAt !== null && performance.now() - appearedAt >= 650) break;
      }
      return frames;
    });
  const entered = (frames: { y: number; opacity: number }[]) => {
    check(
      Math.max(...frames.map((frame) => frame.y)) > 50,
      true,
      "Overlay starts below its final position",
    );
    check(
      new Set(
        frames
          .filter((frame) => frame.y > 1)
          .map((frame) => Math.round(frame.y)),
      ).size > 5,
      true,
      "Overlay has intermediate entrance positions",
    );
    check(
      frames.some((frame) => frame.opacity > 0.01 && frame.opacity < 0.3),
      true,
      "Backdrop fades in",
    );
    check(Math.abs(frames.at(-1)!.y) < 1, true, "Overlay entrance settles");
  };
  let entrance = sampleOverlay();
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  entered(await entrance);
  const exit = sampleOverlay();
  await page.getByRole("button", { name: "Close", exact: true }).tap();
  const closing = await exit;
  check(
    new Set(
      closing
        .filter((frame) => frame.y > 1)
        .map((frame) => Math.round(frame.y)),
    ).size > 5,
    true,
    "Overlay has intermediate exit positions",
  );
  check(
    closing.some((frame) => frame.opacity > 0.01 && frame.opacity < 0.3),
    true,
    "Backdrop fades out",
  );
  check(await page.getByRole("dialog").count(), 0);
  entrance = sampleOverlay();
  await page
    .getByRole("button", { name: "Add food to Breakfast", exact: true })
    .tap();
  entered(await entrance);
  const initial = (await page.getByRole("dialog").boundingBox())!.height;
  // Sample actual rendered heights at each frame, with normal motion enabled.
  const samples = page.evaluate(async (initial) => {
    const samples: {
      height: number;
      bottom: number;
      viewportBottom: number;
      scale: number;
    }[] = [];
    const deadline = performance.now() + 5000;
    let resizingAt: number | null = null;
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
      const sheet = document.querySelector<HTMLElement>(".sheet")!;
      const rect = sheet.getBoundingClientRect();
      if (Math.abs(rect.height - initial) > 1) resizingAt ??= performance.now();
      const transform = new DOMMatrix(getComputedStyle(sheet).transform);
      samples.push({
        height: rect.height,
        bottom: rect.bottom,
        viewportBottom: sheet
          .closest(".sheet-viewport")!
          .getBoundingClientRect().bottom,
        scale: transform.a,
      });
      if (resizingAt !== null && performance.now() - resizingAt >= 1000) break;
    }
    return samples;
  }, initial);
  await page.getByRole("button", { name: /^Greek yogurt/ }).tap();
  const heights = await samples;
  const final = heights.at(-1)!.height;
  check(
    final < initial - 80,
    true,
    "Food detail drawer is shorter than search",
  );
  check(
    new Set(
      heights
        .filter((s) => s.height < initial - 2 && s.height > final + 2)
        .map((s) => Math.round(s.height)),
    ).size > 5,
    true,
    "Drawer resizes through intermediate heights",
  );
  check(
    heights.every(
      (s) =>
        Math.abs(s.bottom - s.viewportBottom) < 2 &&
        Math.abs(s.scale - 1) < 0.001,
    ),
    true,
    "Drawer remains bottom anchored without scaling",
  );
  await page.getByRole("button", { name: "Back to search", exact: true }).tap();
  await page.waitForTimeout(650);
  check(
    (await page.getByRole("dialog").boundingBox())!.height > final + 80,
    true,
    "Returning to search expands the drawer",
  );
  await close(page);
}
async function dragChecks(page: Page) {
  const gesture = await gestures(page);
  const row = (name: string) =>
    page.getByRole("button", { name: `Edit ${name}`, exact: true });
  const drag = async (name: string, destination: Locator, cancel = false) => {
    await row(name).scrollIntoViewIfNeeded();
    const start = await point(row(name));
    const end = await point(destination);
    await gesture.send("start", start.x, start.y);
    await page.waitForTimeout(230);
    // Mouse activation is distance-based; touch activation is long-press.
    await gesture.send("move", start.x, start.y + 6);
    await page.locator(".entry-drag-overlay .entry-button").waitFor();
    for (let step = 1; step <= 8; step++) {
      await gesture.send(
        "move",
        start.x + ((end.x - start.x) * step) / 8,
        start.y + ((end.y - start.y) * step) / 8,
      );
      await page.waitForTimeout(25);
    }
    if (cancel) await page.keyboard.press("Escape");
    else await shot(page, "caloric-touch-drag");
    await gesture.send("end");
    await page
      .locator(".entry-drag-overlay .entry-button")
      .waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    check(await page.getByRole("dialog").count(), 0); // Drag release must not edit.
  };
  try {
    const initial = [
      "Greek yogurt",
      "Blueberries",
      "Honey & oat granola",
      "Flat white",
    ];
    check(await journalNames(page, "Breakfast"), initial);
    if (engine === chromium) {
      // A short swipe beginning on the food row must scroll instead of reorder.
      await row("Greek yogurt").scrollIntoViewIfNeeded();
      const start = await point(row("Greek yogurt"));
      const before = await page.evaluate(() => scrollY);
      await gesture.send("start", start.x, start.y);
      for (let i = 1; i <= 5; i++) {
        await gesture.send("move", start.x, start.y - i * 20);
        await page.waitForTimeout(10);
      }
      await gesture.send("end");
      await page.waitForTimeout(250);
      check(
        await page.evaluate((before) => scrollY > before + 30, before),
        true,
      );
      check(await page.locator(".entry-drag-overlay .entry-button").count(), 0);
      check(await journalNames(page, "Breakfast"), initial);
    }
    await drag("Greek yogurt", row("Honey & oat granola"));
    check(await page.locator(".toast").count(), 0);
    check(await journalNames(page, "Breakfast"), [
      "Blueberries",
      "Honey & oat granola",
      "Greek yogurt",
      "Flat white",
    ]);
    await page.reload();
    await calories(page, "1,256");
    check(await journalNames(page, "Breakfast"), [
      "Blueberries",
      "Honey & oat granola",
      "Greek yogurt",
      "Flat white",
    ]);

    await drag("Greek yogurt", row("Blueberries"), true);
    check(await journalNames(page, "Breakfast"), [
      "Blueberries",
      "Honey & oat granola",
      "Greek yogurt",
      "Flat white",
    ]);
    await page.route("**/sync/push", (route) =>
      route.fulfill({
        status: 503,
        json: { message: "Reorder connection failure" },
      }),
    );
    await drag("Greek yogurt", row("Blueberries"));
    await page
      .getByRole("status")
      .filter({ hasText: "Reorder connection failure" })
      .waitFor();
    check(await journalNames(page, "Breakfast"), [
      "Blueberries",
      "Honey & oat granola",
      "Greek yogurt",
      "Flat white",
    ]);
    await page.unroute("**/sync/push");
    await page
      .getByRole("button", { name: "Dismiss notification", exact: true })
      .tap();

    // Empty containers must accept drops; crossing meal headers must not move headers.
    await drag(
      "Banana",
      page.getByRole("button", { name: "No dinner entries yet.", exact: true }),
    );
    check(await journalNames(page, "Dinner"), ["Banana"]);
    check(await journalNames(page, "Snacks"), ["Almonds"]);
    const persisted = await saved(page);
    check(
      persisted.foodEntries.find((row: any) => row.id === "demo_0_banana").data
        .meal,
      "dinner",
    );
    await page.reload();
    await calories(page, "1,256");
    check(await journalNames(page, "Dinner"), ["Banana"]);

    // Library keyboard sorting must not trigger the app's day navigation or editing.
    await row("Greek yogurt").focus();
    await page.keyboard.press("Space");
    await page.locator(".entry-drag-overlay .entry-button").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(
      () =>
        document
          .querySelector(
            '[aria-label="Breakfast"] .meal-row:last-child .entry-button',
          )
          ?.getAttribute("aria-label") === "Edit Greek yogurt",
    );
    await page.keyboard.press("Space");
    await page.waitForTimeout(350);
    check(await journalNames(page, "Breakfast"), [
      "Blueberries",
      "Honey & oat granola",
      "Flat white",
      "Greek yogurt",
    ]);
    check(await page.getByRole("dialog").count(), 0);
    check(
      await row("Greek yogurt").evaluate(
        (node) => document.activeElement === node,
      ),
      true,
    );

    // Hold at the screen edge: the journal must scroll without another gesture.
    await row("Flat white").scrollIntoViewIfNeeded();
    const start = await point(row("Flat white"));
    const before = await page.evaluate(() => scrollY);
    await gesture.send("start", start.x, start.y);
    await page.waitForTimeout(230);
    await gesture.send("move", start.x, start.y + 6);
    await page.locator(".entry-drag-overlay .entry-button").waitFor();
    await gesture.send("move", start.x, page.viewportSize()!.height - 12);
    await page.waitForFunction((before) => scrollY > before + 100, before, {
      timeout: 3000,
    });
    check(
      await page.evaluate((before) => scrollY > before + 100, before),
      true,
    );
    await page.keyboard.press("Escape");
    await gesture.send("end");
    await page
      .locator(".entry-drag-overlay .entry-button")
      .waitFor({ state: "detached" });
    check(await journalNames(page, "Breakfast"), [
      "Blueberries",
      "Honey & oat granola",
      "Flat white",
      "Greek yogurt",
    ]);
    check(await journalNames(page, "Dinner"), ["Banana"]);

    // Bottom sheets use the library's swipe gesture, not our own dismissal logic.
    await page
      .getByRole("button", { name: "Add food to Breakfast", exact: true })
      .tap();
    await page.getByRole("dialog").waitFor();
    const grabber = await point(page.locator(".sheet-grabber"));
    await gesture.send("start", grabber.x, grabber.y);
    for (let step = 1; step <= 12; step++) {
      await gesture.send("move", grabber.x, grabber.y + step * 20);
      await page.waitForTimeout(10);
    }
    await gesture.send("end");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    check(await page.getByRole("dialog").count(), 0);
  } finally {
    await gesture.dispose();
  }
}
try {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole("heading", { name: "Caloric", exact: true }).waitFor();
  await page.getByLabel("Email", { exact: true }).waitFor();
  check(await page.locator(".auth-footnote, .auth-card img").count(), 0);
  await shot(page, "caloric-native-sign-in");
  await signIn(page, "preview@caloric.local");
  const session = await (
    await page.request.get(`${url}/api/auth/get-session`)
  ).json();
  check(session.user.id, "web_preview_primary"); // Seeded local DB guard before writes.
  await friendLoadingChecks(page);
  check(
    await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    true,
  );
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await shot(page, "caloric-native-mobile");
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await shot(page, "caloric-native-meals");
  await page.evaluate(() => scrollTo(0, 0));
  await page
    .getByRole("button", { name: "Open Alex Rivera's day", exact: true })
    .tap();
  await page.locator('.sheet [data-testid="day-calories"]').waitFor();
  check(
    await page.locator('.sheet [data-testid="day-calories"]').textContent(),
    "1,359",
  );
  check(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Edit / })
      .count(),
    0,
  );
  await shot(page, "caloric-native-friend");
  await close(page);
  await page
    .getByRole("button", { name: "Add food to Breakfast", exact: true })
    .tap();
  check(
    await page.evaluate(
      () => !!document.activeElement?.matches('input[type="search"]'),
    ),
    true,
  );
  await shot(page, "caloric-native-foods");
  await page.getByRole("button", { name: /^Greek yogurt/ }).tap();
  await page
    .getByRole("spinbutton", { name: "Servings", exact: true })
    .fill("1.25");
  await shot(page, "caloric-native-portion");
  await close(page);
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  await page.getByRole("button", { name: "Dark", exact: true }).tap();
  await close(page);
  await page.evaluate(() => scrollTo(0, 0));
  await shot(page, "caloric-native-dark");
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 844 });
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    check(
      await page
        .locator(".meal-stats .macro-badges")
        .evaluateAll((groups) =>
          groups.every((group) => group.scrollWidth <= group.clientWidth),
        ),
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  await page.getByRole("button", { name: "Light", exact: true }).tap();
  await page.getByRole("button", { name: "Sign out", exact: true }).tap();
  await page.getByLabel("Email", { exact: true }).waitFor();
  check((await page.request.get(`${url}/sync/bootstrap`)).status(), 401);
  check(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("caloric.web.queries") || "null")
          ?.clientState.queries.length ?? 0,
    ),
    0,
  );

  const email = `web-e2e-${crypto.randomUUID()}@caloric.local`;
  await page.getByRole("button", { name: "Password", exact: true }).tap();
  await page
    .getByRole("button", { name: "New here? Create an account", exact: true })
    .tap();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Name", { exact: true }).fill("Web test");
  await page.getByLabel("Password", { exact: true }).fill("CaloricPreview123!");
  await page.getByRole("button", { name: "Create account", exact: true }).tap();
  await calories(page, "0");
  const fixture = createDemo(dateKey());
  const seeded = await page.request.post(`${url}/sync/push`, {
    headers: { Origin: url },
    data: {
      foodEntries: fixture.entries,
      recipes: fixture.recipes,
      settings: {
        id: "settings",
        data: fixture.settings,
        updatedAt: Date.now(),
      },
    },
  });
  check(seeded.status(), 200);
  await page.reload();
  await calories(page, "1,256");
  await dragChecks(page);
  // Restore only this fresh test account for the existing CRUD checks.
  check(
    (
      await page.request.post(`${url}/sync/push`, {
        headers: { Origin: url },
        data: {
          foodEntries: fixture.entries.map((row) => ({
            ...row,
            updatedAt: Date.now(),
          })),
        },
      })
    ).status(),
    200,
  );
  await page.reload();
  await calories(page, "1,256");
  await page.evaluate(() => scrollTo(0, 0));
  // Add to a different, off-screen meal: the add itself must reveal the row.
  await page
    .getByRole("button", { name: "Add food to Breakfast", exact: true })
    .tap();
  await page.getByRole("button", { name: /^Baked salmon/ }).tap();
  await page.getByRole("dialog").getByRole("combobox").selectOption("dinner");
  await page
    .getByRole("spinbutton", { name: "Servings", exact: true })
    .fill("1.5");
  check(
    (await page.locator(".nutrition-grid > div").first().innerText()).trim(),
    "Calories\n464 kcal",
  );
  await page.getByRole("button", { name: "Add to Dinner", exact: true }).tap();
  await calories(page, "1,720");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await addedVisible(
    page,
    (await page
      .getByRole("button", { name: "Edit Baked salmon", exact: true })
      .locator("..")
      .getAttribute("data-entry-id"))!,
  );
  check(await page.locator(".toast").count(), 0);
  await shot(page, "caloric-added-item");
  await page.reload();
  await calories(page, "1,720");
  check(
    (await saved(page)).foodEntries.find(
      (row: any) =>
        row.data.dateKey === dateKey() && row.data.foodName === "Baked salmon",
    ).data.portion,
    1.5,
  );
  await page
    .getByRole("button", { name: "Edit Baked salmon", exact: true })
    .tap();
  await page
    .getByRole("spinbutton", { name: "Servings", exact: true })
    .fill("0.75");
  await page.getByLabel("Meal", { exact: true }).selectOption("lunch");
  await page.getByRole("button", { name: "Save changes", exact: true }).tap();
  await calories(page, "1,488");
  check(
    await page
      .getByRole("region", { name: "Lunch", exact: true })
      .getByRole("button", { name: "Edit Baked salmon", exact: true })
      .count(),
    1,
  );
  await page
    .getByRole("button", { name: "Edit Baked salmon", exact: true })
    .tap();
  check(
    await page.getByRole("button", { name: /^Move (up|down)$/ }).count(),
    0,
  );
  await shot(page, "caloric-native-editor");
  await close(page);
  await page
    .getByRole("button", { name: "Edit Baked salmon", exact: true })
    .focus();
  await page.keyboard.press("Space");
  await page.locator(".entry-drag-overlay .entry-button").waitFor();
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(
    () =>
      Array.from(
        document.querySelectorAll('[aria-label="Lunch"] .entry-button'),
      )
        .at(-2)
        ?.getAttribute("aria-label") === "Edit Baked salmon",
  );
  await page.keyboard.press("Space");
  await page.waitForTimeout(350);
  check(
    (
      await page
        .getByRole("region", { name: "Lunch", exact: true })
        .locator(".entry-button")
        .allTextContents()
    )
      .slice(-2)
      .map((text) => text.startsWith("Baked salmon")),
    [true, false],
  );
  await page.getByRole("button", { name: "Edit Almonds", exact: true }).tap();
  await page
    .getByRole("button", { name: "Remove from journal", exact: true })
    .tap();
  await page.getByRole("button", { name: "Remove food", exact: true }).tap();
  await calories(page, "1,372");
  await page.getByRole("button", { name: "Undo", exact: true }).tap();
  await calories(page, "1,488");
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  await page.getByLabel("Calorie goal").fill("2400");
  await page.getByLabel("Protein %").fill("32");
  check(
    await page
      .getByRole("button", { name: "Save goals", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByLabel("Protein %").fill("33");
  await page.getByLabel("Fat %").fill("22");
  await page.getByRole("button", { name: "Save goals", exact: true }).tap();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  check((await saved(page)).settings.data, {
    calorieGoal: 2400,
    macroProteinPct: 33,
    macroCarbsPct: 45,
    macroFatPct: 22,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  await page.getByRole("button", { name: "Recipes", exact: true }).tap();
  await page.getByRole("button", { name: "Create recipe", exact: true }).tap();
  await page.getByLabel("Recipe name").fill("Test bowl");
  const ingredients = page.getByLabel("Add ingredient from recent foods");
  const yogurtId = await ingredients
    .locator("option")
    .filter({ hasText: /^Greek yogurt$/ })
    .getAttribute("value");
  await ingredients.selectOption(yogurtId!);
  await page.getByLabel("Servings of Greek yogurt").fill("1.5");
  const bananaId = await ingredients
    .locator("option")
    .filter({ hasText: /^Banana$/ })
    .getAttribute("value");
  await ingredients.selectOption(bananaId!);
  await page.getByLabel("Servings of Banana").fill("0.75");
  await page.getByRole("button", { name: "Save recipe", exact: true }).tap();
  await page.getByRole("button", { name: /^Test bowl/ }).waitFor();
  await close(page);
  await page
    .getByRole("button", { name: "Add food to Dinner", exact: true })
    .tap();
  await page.getByRole("button", { name: "Recipes", exact: true }).tap();
  await page.getByRole("button", { name: /^Test bowl/ }).tap();
  await page
    .getByRole("spinbutton", { name: "Servings", exact: true })
    .fill("2");
  await page.getByRole("button", { name: "Add to Dinner", exact: true }).tap();
  await calories(page, "2,005"); // 1256 + 309×.75 + (120×1.5 + 105×.75)×2
  await page.reload();
  await calories(page, "2,005");
  check((await saved(page)).recipes.length, 4);

  // A real journal with a failed network write must retain its last saved value.
  await page.route("**/sync/push", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Test connection failure" },
    }),
  );
  await page
    .getByRole("button", { name: "Edit Greek yogurt", exact: true })
    .tap();
  await page
    .getByRole("spinbutton", { name: "Servings", exact: true })
    .fill("2");
  await page.getByRole("button", { name: "Save changes", exact: true }).tap();
  await page
    .getByRole("alert")
    .filter({ hasText: "Test connection failure" })
    .waitFor();
  check(
    await page.locator('[data-testid="day-calories"]').first().textContent(),
    "2,005",
  );
  check(await page.getByRole("dialog").count(), 1);
  await close(page);
  await page.unroute("**/sync/push");
  await page
    .getByRole("button", { name: "Add food to Dinner", exact: true })
    .tap();
  await page.goBack();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Next day", exact: true }).tap();
  await calories(page, "0");
  check(
    await page
      .getByRole("button", { name: "No breakfast entries yet.", exact: true })
      .count(),
    1,
  );
  await page.getByRole("button", { name: "Back to today", exact: true }).tap();
  await calories(page, "2,005");
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  await page.getByRole("button", { name: "Sign out", exact: true }).tap();
  await page.getByLabel("Email", { exact: true }).waitFor();
  await signIn(page, email);
  await calories(page, "2,005");
  check(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.includes("demo")),
    ),
    [],
  );
  await portionChecks(page);
  const videoDir = artifacts
    ? await mkdtemp(join(tmpdir(), "caloric-motion-"))
    : undefined;
  const animated = await browser.newContext({
    ...devices["iPhone 13"],
    deviceScaleFactor: 2,
    reducedMotion: "no-preference",
    storageState: await context.storageState(),
    recordVideo: videoDir
      ? { dir: videoDir, size: { width: 390, height: 844 } }
      : undefined,
  });
  const animatedPage = await animated.newPage();
  animatedPage.on("pageerror", (error) => errors.push(error.message));
  await animatedPage.goto(url);
  await calories(animatedPage, "2,785");
  await resizeChecks(animatedPage);
  // With normal motion too, adding from Breakfast into off-screen Dinner
  // must reveal the row after the overlay closes, without a success toast.
  await animatedPage.evaluate(() => scrollTo(0, 0));
  await animatedPage
    .getByRole("button", { name: "Add food to Breakfast", exact: true })
    .tap();
  await animatedPage.getByRole("button", { name: /^Baked salmon/ }).tap();
  await animatedPage
    .getByRole("dialog")
    .getByRole("combobox")
    .selectOption("dinner");
  await animatedPage
    .getByRole("button", { name: "Add to Dinner", exact: true })
    .tap();
  await animatedPage.getByRole("dialog").waitFor({ state: "detached" });
  await calories(animatedPage, "3,094");
  const addedRow = animatedPage
    .getByRole("region", { name: "Dinner", exact: true })
    .getByRole("button", { name: "Edit Baked salmon", exact: true })
    .locator("..");
  await addedVisible(
    animatedPage,
    (await addedRow.getAttribute("data-entry-id"))!,
  );
  await shot(animatedPage, "caloric-added-item");
  const video = animatedPage.video();
  await animated.close();
  if (artifacts && video && videoDir) {
    await copyFile(
      await video.path(),
      `${artifacts}/caloric-drawer-resize.webm`,
    );
    await rm(videoDir, { recursive: true });
  }
  check(errors, []);
  await context.close();
  console.log(
    `PASS: ${assertions} browser assertions (${engine === webkit ? "WebKit" : "Chromium"}): real auth/DB, CRUD persistence, recipes, goals, friends, ${engine === chromium ? "touch scroll/long-press" : "mouse"} sorting, cross-meal/empty drops, cancel/failed reorder rollback, keyboard, auto-scroll, swipe sheets, narrow widths, dark mode, Back, hold-and-slide portions, overlay entrance/fade, animated drawer resizing and revealing added rows without toasts.`,
  );
} finally {
  await browser.close();
}
