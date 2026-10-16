import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDemo, dateKey, type Food } from "./model";

// Deterministic browser test for the food assistant: photo
// attachments (picker, drop, paste), the multipart turn payload, streamed
// events and the review cards. All API traffic is mocked; nothing leaves the
// machine. Screenshots go to CALORIC_SHOTS (default /tmp/caloric-web-shots).
const directory = fileURLToPath(new URL("../dist/web/", import.meta.url));
const shots = process.env.CALORIC_SHOTS || "/tmp/caloric-web-shots";
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(`${directory}${path.replace(/^\/(web\/)?/, "")}`);
    return new Response((await file.exists()) && path !== "/" ? file : Bun.file(`${directory}index.html`));
  },
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const errors: string[] = [];
const food = (id: string, name: string, calories: number, extra: Partial<Food> = {}): Food => ({
  id,
  name,
  serving: "1 serving",
  nutrition: { calories, protein: calories / 20, carbs: calories / 12, fat: calories / 40 },
  ...extra,
});
const turns: Array<{ message: string | null; images: string[]; audio: boolean }> = [];
let snapshot = createDemo(dateKey());
let pushed = 0;

// A drawn "plate" photo, rendered by the browser so it is a valid PNG.
const painter = await browser.newPage();
const png = Buffer.from(
  await painter.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 900;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#c9a27a";
    g.fillRect(0, 0, 1200, 900);
    g.fillStyle = "#f4f1ea";
    g.beginPath();
    g.arc(600, 450, 380, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#d9a55b";
    g.fillRect(380, 300, 360, 260);
    g.fillStyle = "#7da043";
    g.fillRect(410, 330, 300, 120);
    for (const [x, y] of [[800, 380], [780, 560]]) {
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.arc(x, y, 90, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#f5b51b";
      g.beginPath();
      g.arc(x, y, 38, 0, Math.PI * 2);
      g.fill();
    }
    return canvas.toDataURL("image/png").split(",")[1]!;
  }),
  "base64",
);
await painter.close();

async function run(scheme: "light" | "dark") {
  const context = await browser.newContext({
    viewport: { width: 430, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const path = target.pathname;
    if (path === "/api/auth/get-session") return route.fulfill({ json: { user: { id: "next-user" } } });
    if (path === "/sync/bootstrap")
      return route.fulfill({
        json: { foodEntries: snapshot.entries, recipes: snapshot.recipes, settings: { id: "settings", data: snapshot.settings, updatedAt: 1 } },
      });
    if (path === "/sync/push") {
      const data = request.postDataJSON();
      pushed += data.foodEntries.length;
      return route.fulfill({
        json: { acceptedFoodEntryIds: data.foodEntries.map((row: { id: string }) => row.id), acceptedRecipeIds: [], acceptedSettings: false },
      });
    }
    if (path === "/social/daily-summaries") return route.fulfill({ json: { summaries: [] } });
    if (path === "/social/me")
      return route.fulfill({ json: { profile: { userId: "next-user", displayName: "Next", friendCode: "N-1" }, friends: [], incomingRequests: [], outgoingRequests: [] } });
    if (path === "/ai/session") {
      assert.equal(request.postDataJSON().variant, undefined);
      return route.fulfill({ json: { sessionId: "assistant-session" } });
    }
    if (path === "/ai/turn") {
      const body = request.postDataBuffer()!.toString("latin1");
      const images = [...body.matchAll(/name="image"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)/g)].map((m) => `${m[1]}:${m[2]}`);
      const message = /name="message"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? null;
      turns.push({ message, images, audio: body.includes('name="audio"') });
      const events = [
        { type: "turn", turnId: "turn-1" },
        { type: "event", seq: 0, event: { kind: "search", query: "avocado toast", foods: [food("off-1", "Avocado toast", 290, { brand: "Café", serving: "1 slice" })] } },
        { type: "event", seq: 1, event: { kind: "search", query: "fried egg", foods: [food("mfp-2", "Fried egg", 90, { serving: "1 large" })] } },
        { type: "event", seq: 2, event: { kind: "assistant", text: "Looks like avocado toast with two fried eggs." } },
        {
          type: "event",
          seq: 3,
          event: {
            kind: "approval",
            toolCallId: "call-1",
            suggestions: [
              { suggestionId: "s-1", resultId: "r1", meal: "breakfast", portion: 1, reason: "One slice of sourdough with about half an avocado.", food: food("off-1", "Avocado toast", 290, { brand: "Café", serving: "1 slice" }) },
              { suggestionId: "s-2", resultId: "r2", meal: "breakfast", portion: 2, reason: "Two eggs visible on the plate.", food: food("mfp-2", "Fried egg", 90, { serving: "1 large" }) },
            ],
          },
        },
        { type: "status", seq: 4, status: "ready" },
      ];
      return route.fulfill({ contentType: "text/event-stream", body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
    }
    if (/^\/(api|sync|social|search|ai)(\/|$)/.test(path)) throw new Error(`Unhandled API request: ${path}`);
    return route.continue();
  });

  await page.goto(`${server.url}`);
  await page.getByText("What did you eat?").first().waitFor();
  await page.screenshot({ path: `${shots}/home-${scheme}.png` });

  // Home shortcut: the photo button opens the picker and the assistant with the photo attached.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Log food from a photo" }).click();
  await (await chooser).setFiles([{ name: "plate.png", mimeType: "image/png", buffer: png }]);
  await page.getByRole("img", { name: "Photo to send" }).waitFor();
  await page.screenshot({ path: `${shots}/attached-${scheme}.png` });

  // Paste a second photo into the composer.
  await page.getByLabel("Message Caloric").evaluate((field, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "label.png", { type: "image/png" }));
    field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...png]);
  await page.waitForFunction(() => document.querySelectorAll(".ax-thumb").length === 2);
  await page.getByLabel("Message Caloric").fill("breakfast");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("2 foods to review").waitFor();
  await page.screenshot({ path: `${shots}/suggestions-${scheme}.png`, fullPage: false });

  // Adjust a portion, then add everything at once.
  await page.getByRole("button", { name: "More servings" }).first().click();
  await page.getByText("Add all 2").click();
  await page.getByText("Added to Breakfast").first().waitFor();
  await page.screenshot({ path: `${shots}/added-${scheme}.png` });
  await context.close();
}

try {
  await run("light");
  assert.deepEqual(turns[0], { message: "breakfast", images: ["photo-1.jpg:image/jpeg", "photo-2.jpg:image/jpeg"], audio: false });
  assert.equal(pushed, 2);
  snapshot = createDemo(dateKey());
  await run("dark");
  assert.deepEqual(errors, []);
  console.log(`assistant e2e passed; screenshots in ${shots}`);
} finally {
  await browser.close();
  server.stop(true);
}
