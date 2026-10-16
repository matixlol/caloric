// Offline evaluation of assistant models against exported production chats.
//
// Exported chats contain user voice notes and food logs, so keep every input and
// output of this script outside the repository (the defaults live under /tmp).
//
//   bun scripts/ai-eval.ts export                      # needs PROD_DATABASE_URL
//   bun scripts/ai-eval.ts transcribe                  # reference transcripts (OpenRouter)
//   bun scripts/ai-eval.ts run meta/muse-wonder [--reasoning low]   # any OpenRouter model ID
//   bun scripts/ai-eval.ts judge <run.json>...         # hindsight grading (OpenRouter)
//   bun scripts/ai-eval.ts report <graded.json>...
//
// `run` replays the first user turn of every exported session through the real
// agent loop. Food searches go to the public production /search endpoint and are
// cached on disk, so every model sees identical search results.

import type { ModelMessage } from "ai";
import { mkdir, rename } from "node:fs/promises";
import { transcodeAudioToWav } from "../src/services/audio";
import { parseArgs } from "node:util";

process.env.DATABASE_URL ??= "postgres://unused@localhost:1/unused";
process.env.BETTER_AUTH_SECRET ??= "ai-eval";

const { values: flags, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    dir: { type: "string", default: "/tmp/caloric-exp" },
    reasoning: { type: "string", default: "minimal" },
    transcriber: { type: "string", default: "google/gemini-4-argon" },
    concurrency: { type: "string", default: "6" },
    limit: { type: "string" },
    label: { type: "string" },
    judge: { type: "string", default: "anthropic/claude-opus-5.5" },
    search: { type: "string", default: "https://backend.caloric.mati.lol/search" },
    asr: { type: "string" },
    wav: { type: "boolean", default: false },
    // Write judge prompts to batch files for external graders (e.g. Claude subagents)
    // instead of calling a judge model; merge their answers with `judge-import`.
    export: { type: "string" },
    // judgements file for judge-import/report, e.g. judgements-claude.json for subagent grades.
    cache: { type: "string", default: "judgements.json" },
  },
});

const dir = flags.dir!;
// A provider error can surface on an unobserved stream promise; log it instead of
// killing a long run. The affected case is still recorded as an error.
process.on("unhandledRejection", (error) => console.error("unhandled", error instanceof Error ? error.message.slice(0, 200) : error));
process.on("uncaughtException", (error) => console.error("uncaught", error.message.slice(0, 200)));
const command = positionals[0];

type ExportedSession = { id: string; user_id: string; created_at: string; conversation: ModelMessage[] };
type Suggestion = { meal: string; portion: number; reason: string; food: { name: string; brand?: string; serving?: string; nutrition?: { calories?: number; protein?: number; carbs?: number; fat?: number } } };
type CaseResult = {
  sessionId: string;
  model: string;
  reasoning: string;
  ms: number;
  error?: string;
  searches: string[];
  texts: string[];
  suggestions: Suggestion[];
  inputTokens?: number;
  steps?: number;
  outputTokens?: number;
  costUsd?: number;
};

async function readJson<T>(name: string): Promise<T> {
  return (await Bun.file(name.startsWith("/") ? name : `${dir}/${name}`).json()) as T;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!, index);
      }
    }),
  );
  return results;
}

function firstUserIndex(conversation: ModelMessage[]): number {
  return conversation.findIndex((message) => message.role === "user");
}

function describeUserMessage(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as Array<{ type: string; text?: string; mediaType?: string }>)
    .map((part) => (part.type === "text" ? part.text : `[${part.mediaType ?? part.type}]`))
    .join(" ");
}

async function exportSessions() {
  const url = process.env.PROD_DATABASE_URL;
  if (!url) throw new Error("PROD_DATABASE_URL is required");
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 1 });
  const rows = await sql`select id, user_id, created_at, conversation from ai_sessions order by created_at`;
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/sessions.json`, JSON.stringify(rows));
  console.log(`exported ${rows.length} sessions to ${dir}/sessions.json`);
  await sql.end();
}

// Reference transcripts of every user audio clip, used only by the judge.
async function transcribe() {
  const { generateText } = await import("ai");
  const { createAssistantModel } = await import("../src/services/ai-models");
  const sessions = await readJson<ExportedSession[]>("sessions.json");
  const cachePath = `${dir}/transcripts.json`;
  const cache: Record<string, string> = (await Bun.file(cachePath).exists()) ? await readJson(cachePath) : {};
  const model = createAssistantModel(flags.transcriber!, "low", { openRouterApiKey: process.env.OPENROUTER_API_KEY });
  const clips: Array<{ key: string; part: { data: string; mediaType: string } }> = [];
  for (const session of sessions) {
    session.conversation.forEach((message, index) => {
      if (message.role !== "user" || typeof message.content === "string") return;
      for (const part of message.content as Array<{ type: string; data?: string; mediaType?: string }>) {
        if (part.type === "file" && part.mediaType?.startsWith("audio/") && part.data) {
          const key = `${session.id}#${index}`;
          if (!cache[key]) clips.push({ key, part: { data: part.data, mediaType: part.mediaType } });
        }
      }
    });
  }
  console.log(`transcribing ${clips.length} clips`);
  await mapLimit(clips, Number(flags.concurrency), async ({ key, part }) => {
    try {
      const { text } = await generateText({
        model: model.model,
        providerOptions: model.providerOptions,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this voice note verbatim in its original language. Output only the transcript." },
              { type: "file", data: part.data, mediaType: part.mediaType },
            ],
          },
        ],
      });
      cache[key] = text.trim();
    } catch (error) {
      console.error(key, error instanceof Error ? error.message : error);
    }
  });
  await Bun.write(cachePath, JSON.stringify(cache, null, 1));
}

async function cachedSearch() {
  const cachePath = `${dir}/search-cache.json`;
  const cache: Record<string, unknown[]> = (await Bun.file(cachePath).exists()) ? await readJson(cachePath) : {};
  const inflight = new Map<string, Promise<unknown[]>>();
  let dirty = 0;
  // Parallel runs share the file, so merge with whatever is on disk before writing.
  const persist = async () => {
    const disk: Record<string, unknown[]> = (await Bun.file(cachePath).exists()) ? await readJson<Record<string, unknown[]>>(cachePath).catch(() => ({})) : {};
    Object.assign(cache, { ...disk, ...cache });
    const temp = `${cachePath}.${process.pid}`;
    await Bun.write(temp, JSON.stringify(cache));
    await rename(temp, cachePath);
  };
  const search = async (query: string, limit: number) => {
    const key = `${query.trim().toLowerCase()}|${limit}`;
    if (cache[key]) return cache[key] as never[];
    if (!inflight.has(key)) {
      inflight.set(
        key,
        (async () => {
          for (let attempt = 0; ; attempt++) {
            const response = await fetch(`${flags.search}?query=${encodeURIComponent(query)}&maxItems=${limit}`);
            if (response.ok) {
              const foods = ((await response.json()) as { foods: unknown[] }).foods;
              cache[key] = foods;
              if (++dirty % 10 === 0) await persist();
              return foods;
            }
            if (attempt >= 2) throw new Error(`search failed ${response.status} for ${query}`);
            await Bun.sleep(1000 * (attempt + 1));
          }
        })(),
      );
    }
    return (await inflight.get(key)!) as never[];
  };
  return { search, flush: persist };
}

// Speech-to-text for models without audio input: transcribe each first-turn
// clip once per ASR model, biased with the user's recent foods.
async function asrTranscripts(spec: string, sessions: ExportedSession[]) {
  const { generateText } = await import("ai");
  const { createAssistantModel } = await import("../src/services/ai-models");
  const cachePath = `${dir}/asr-${spec.split(",")[0]!.replace(/[^a-z0-9.-]+/gi, "_")}.json`;
  const cache: Record<string, string> = (await Bun.file(cachePath).exists()) ? await readJson(cachePath) : {};
  // A comma-separated list falls back to the next model when one fails.
  const models = spec.split(",").map((one) =>
    createAssistantModel(one.trim(), "minimal", { openRouterApiKey: process.env.OPENROUTER_API_KEY }),
  );
  const jobs = sessions.flatMap((session) => {
    const first = firstUserIndex(session.conversation);
    const message = session.conversation[first]!;
    if (typeof message.content === "string") return [];
    const audio = (message.content as Array<{ type: string; data?: string; mediaType?: string }>).find(
      (part) => part.type === "file" && part.mediaType?.startsWith("audio/"),
    );
    const key = `${session.id}#${first}`;
    if (!audio || cache[key] !== undefined) return [];
    const context = String(session.conversation.find((m, i) => i > 0 && m.role === "system")?.content ?? "");
    const foods = [...context.matchAll(/^- (.+)$/gm)].slice(0, 15).map((m) => m[1]!.split(" | ").slice(2, 4).join(" "));
    return [{ key, audio: audio as { data: string; mediaType: string }, foods }];
  });
  if (jobs.length) console.log(`asr ${spec}: transcribing ${jobs.length} clips`);
  await mapLimit(jobs, Number(flags.concurrency), async ({ key, audio: original, foods }) => {
    const audio = await toWav(original);
    for (const asr of models) try {
      const { text } = await generateText({
        model: asr.model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Transcribe this food-logging voice note verbatim in its original language (often English or Rioplatense Spanish, sometimes mixed). Output only the transcript.${foods.length ? ` Foods this user logged recently, for spelling brand names: ${foods.join("; ")}.` : ""}`,
              },
              { type: "file", data: audio.data, mediaType: audio.mediaType },
            ],
          },
        ],
      });
      cache[key] = text.trim();
      break;
    } catch (error) {
      console.error("asr", asr.id, key, error instanceof Error ? error.message.slice(0, 160) : error);
    }
  });
  await Bun.write(cachePath, JSON.stringify(cache, null, 1));
  return cache;
}

// Several models accept only WAV/MP3/FLAC; decode with the same ffmpeg path production uses.
async function toWav(audio: { data: string; mediaType: string }) {
  if (audio.mediaType.includes("wav")) return audio;
  return { data: (await transcodeAudioToWav(Buffer.from(audio.data, "base64"))).toString("base64"), mediaType: "audio/wav" };
}

// Some audio-native providers only accept WAV/MP3/FLAC.
async function withWavAudio(message: ModelMessage): Promise<ModelMessage> {
  if (typeof message.content === "string") return message;
  const content = await Promise.all(
    (message.content as Array<{ type: string; data?: string; mediaType?: string }>).map(async (part) =>
      part.type === "file" && part.mediaType?.startsWith("audio/") && part.data
        ? { ...part, ...(await toWav({ data: part.data, mediaType: part.mediaType })) }
        : part,
    ),
  );
  return { role: "user", content } as ModelMessage;
}

function withTranscript(message: ModelMessage, transcript: string | undefined): ModelMessage {
  if (transcript === undefined || typeof message.content === "string") return message;
  const parts = (message.content as Array<{ type: string; mediaType?: string }>).filter(
    (part) => !(part.type === "file" && part.mediaType?.startsWith("audio/")),
  );
  return {
    role: "user",
    content: [...parts, { type: "text", text: `Voice note (automatic transcript, may contain recognition errors): "${transcript}"` }],
  } as ModelMessage;
}

async function run(spec: string) {
  const { runAssistantLoop, systemPrompt } = await import("../src/services/ai-agent");
  const { createAssistantModel } = await import("../src/services/ai-models");
  const sessions = await readJson<ExportedSession[]>("sessions.json");
  const cases = sessions.filter((session) => firstUserIndex(session.conversation) >= 0).slice(0, flags.limit ? Number(flags.limit) : undefined);
  const assistant = createAssistantModel(spec, flags.reasoning as "minimal", { openRouterApiKey: process.env.OPENROUTER_API_KEY });
  const { search, flush } = await cachedSearch();
  const asr = flags.asr ? await asrTranscripts(flags.asr, cases) : null;
  const label =
    flags.label ??
    `${spec.replace(/[^a-z0-9.-]+/gi, "_")}__${flags.reasoning}${flags.wav ? "__wav" : ""}${flags.asr ? `__asr-${flags.asr.split(",")[0]!.replace(/^.*\//, "")}` : ""}`;
  let done = 0;

  const results = await mapLimit(cases, Number(flags.concurrency), async (session): Promise<CaseResult> => {
    const first = firstUserIndex(session.conversation);
    // Keep the recent-log context from production, swap in the current prompt.
    const context = session.conversation.slice(0, first).filter((message, index) => index > 0 && message.role === "system");
    const state = {
      id: session.id,
      userId: session.user_id,
      conversation: [
        { role: "system" as const, content: systemPrompt },
        ...context,
        asr
          ? withTranscript(session.conversation[first]!, asr[`${session.id}#${first}`])
          : flags.wav
            ? await withWavAudio(session.conversation[first]!)
            : session.conversation[first]!,
      ],
      searchResultCounter: 1,
      searchResultsByLocalId: {},
      pendingApprovals: {},
    };
    const result: CaseResult = { sessionId: session.id, model: spec, reasoning: flags.reasoning!, ms: 0, searches: [], texts: [], suggestions: [] };
    const started = performance.now();
    try {
      await runAssistantLoop(state, {
        assistant,
        search,
        onUsage: (usage) => {
          result.inputTokens = (result.inputTokens ?? 0) + usage.inputTokens;
          result.outputTokens = (result.outputTokens ?? 0) + usage.outputTokens;
          if (usage.costUsd !== undefined) result.costUsd = (result.costUsd ?? 0) + usage.costUsd;
        },
        signal: AbortSignal.timeout(180_000),
        onEvent: (event) => {
          if (event.kind === "search") result.searches.push(event.query);
          if (event.kind === "assistant") result.texts.push(event.text);
          if (event.kind === "approval") {
            result.suggestions.push(
              ...event.suggestions.map((s) => ({
                meal: s.meal,
                portion: s.portion,
                reason: s.reason,
                food: { name: s.food.name, brand: s.food.brand ?? undefined, serving: s.food.serving ?? undefined, nutrition: s.food.nutrition },
              })),
            );
          }
        },
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message.slice(0, 300) : String(error);
    }
    result.ms = Math.round(performance.now() - started);
    result.steps = state.conversation.filter((message) => message.role === "assistant").length;
    done++;
    if (done % 10 === 0) console.log(`${label}: ${done}/${cases.length}`);
    return result;
  });

  await flush();
  await mkdir(`${dir}/runs`, { recursive: true });
  const out = `${dir}/runs/${label}.json`;
  await Bun.write(out, JSON.stringify(results, null, 1));
  const errors = results.filter((r) => r.error).length;
  const noSuggestion = results.filter((r) => !r.error && r.suggestions.length === 0).length;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const costed = results.filter((r) => r.costUsd !== undefined);
  if (costed.length) console.log(`${label}: mean cost $${(costed.reduce((a, r) => a + r.costUsd!, 0) / costed.length).toFixed(4)}/request, mean tokens in ${Math.round(costed.reduce((a, r) => a + (r.inputTokens ?? 0), 0) / costed.length)} out ${Math.round(costed.reduce((a, r) => a + (r.outputTokens ?? 0), 0) / costed.length)}`);
  console.log(`${label}: ${results.length} cases, ${errors} errors, ${noSuggestion} without suggestions, p50 ${ms[Math.floor(ms.length / 2)]}ms p90 ${ms[Math.floor(ms.length * 0.9)]}ms -> ${out}`);
}

function hindsight(session: ExportedSession, transcripts: Record<string, string>): { request: string; later: string } {
  const first = firstUserIndex(session.conversation);
  const say = (message: ModelMessage, index: number) => {
    const transcript = transcripts[`${session.id}#${index}`];
    const text = describeUserMessage(message);
    return transcript ? `${text.replace(/\[audio[^\]]*\]/, "").trim()} [voice: "${transcript}"]`.trim() : text;
  };
  const later: string[] = [];
  session.conversation.forEach((message, index) => {
    if (index <= first) return;
    if (message.role === "user") later.push(`USER: ${say(message, index)}`);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type: string; text?: string; toolName?: string; input?: unknown }>) {
        if (part.type === "tool-call" && part.toolName === "searchFoods") later.push(`OLD ASSISTANT searched: ${(part.input as { query: string }).query}`);
      }
    }
  });
  return { request: say(session.conversation[first]!, first), later: later.join("\n").slice(0, 4000) };
}

function describeSuggestions(result: CaseResult): string {
  if (result.error) return `ERROR: ${result.error}`;
  const lines = result.suggestions.map((s) => {
    const kcal = s.food.nutrition?.calories;
    return `- ${s.portion} x [${s.food.name}${s.food.brand ? ` | ${s.food.brand}` : ""}] (serving: ${s.food.serving ?? "?"}, ${kcal ?? "?"} kcal/serving → ${kcal == null ? "?" : Math.round(kcal * s.portion)} kcal) → ${s.meal}. reason: ${s.reason}`;
  });
  const texts = result.texts.map((text) => `assistant said: ${JSON.stringify(text.slice(0, 400))}`);
  return [...lines, ...texts].join("\n") || "(no suggestions, no text)";
}

async function judge(files: string[]) {
  const { generateObject } = await import("ai");
  const { z } = await import("zod");
  const { createAssistantModel } = await import("../src/services/ai-models");
  const sessions = new Map((await readJson<ExportedSession[]>("sessions.json")).map((s) => [s.id, s]));
  const transcripts: Record<string, string> = (await Bun.file(`${dir}/transcripts.json`).exists()) ? await readJson(`transcripts.json`) : {};
  const runs = await Promise.all(files.map((file) => readJson<CaseResult[]>(file)));
  const judgeModel = createAssistantModel(flags.judge!, "low", { openRouterApiKey: process.env.OPENROUTER_API_KEY });
  const cachePath = `${dir}/${flags.cache}`;
  const cache: Record<string, unknown> = (await Bun.file(cachePath).exists()) ? await readJson(cachePath) : {};
  const Grade = z.object({
    grades: z.array(
      z.object({
        label: z.string(),
        score: z.number().min(0).max(10),
        missing: z.number().int().min(0),
        extra: z.number().int().min(0),
        wrongItem: z.number().int().min(0),
        portionOff: z.number().int().min(0),
        wrongMeal: z.number().int().min(0),
        junkText: z.boolean(),
        note: z.string(),
      }),
    ),
  });
  const sessionIds = runs[0]!.map((r) => r.sessionId).slice(0, flags.limit ? Number(flags.limit) : undefined);
  let done = 0;
  const exported: Array<{ caseId: string; sessionId: string; labels: Record<string, string>; prompt: string }> = [];
  await mapLimit(sessionIds, Number(flags.concurrency), async (sessionId) => {
    const session = sessions.get(sessionId)!;
    // Shuffle candidate order per case and hide model names to avoid position/brand bias.
    const candidates = runs
      .map((run, index) => ({ file: files[index]!, result: run.find((r) => r.sessionId === sessionId)! }))
      .filter((c) => c.result)
      .map((c) => ({ ...c, sort: Bun.hash(`${sessionId}${c.file}`) }))
      .sort((a, b) => Number(a.sort) - Number(b.sort));
    const pending = candidates.filter((c) => !cache[`${sessionId}|${c.file}`]);
    if (pending.length === 0) return;
    const { request, later } = hindsight(session, transcripts);
    const context = session.conversation.find((m, i) => i > 0 && m.role === "system");
    const labelled = candidates.map((c, i) => ({ ...c, label: String.fromCharCode(65 + i) }));
    const prompt = [
      "You grade a calorie-tracking assistant. The user asked it to log food; it searched a food database and proposed entries (food, portion multiplier of the food's serving, meal).",
      "Grade each candidate answer independently against what the user actually ate. Use the conversation that happened AFTER this request with the old assistant as hindsight: corrections like 'no, the chocolate one' or '10g protein' reveal the user's true intent.",
      "Scoring (0-10): 10 = every requested food present once, right product/brand/variant (or a plausible generic when the exact one is unlikely to exist), portion converts the stated amount into the serving correctly, meals right, nothing extra. Deduct heavily for missing foods, wrong products, implausible calories, portion math mistakes (e.g. 180 g of a 30 g serving must be 6), and junk/hallucinated text. A clarifying question with no suggestions scores 4 if the request was truly ambiguous, else 1. An error scores 0.",
      "Voice transcripts shown to you are automatic and can be wrong; when a transcript conflicts with the later conversation or with what the old assistant searched without being corrected, trust those. Candidates may have heard the audio differently; don't penalize a reasonable interpretation of genuinely ambiguous audio.",
      "Count issues per candidate: missing, extra, wrongItem, portionOff, wrongMeal; junkText = assistant text that is gibberish, leaked reasoning/transcript, wrong language or unrelated content.",
      "",
      context ? `RECENT LOG CONTEXT GIVEN TO THE ASSISTANT (truncated):\n${String(context.content).slice(0, 1500)}` : "",
      `SESSION TIME (UTC): ${session.created_at}`,
      `USER REQUEST: ${request}`,
      later ? `HINDSIGHT — LATER IN THE ORIGINAL CONVERSATION:\n${later}` : "HINDSIGHT: the user did not follow up.",
      "",
      ...labelled.map((c) => `CANDIDATE ${c.label}:\n${describeSuggestions(c.result)}`),
      "",
      `Return grades for labels ${labelled.map((c) => c.label).join(", ")}.`,
    ].join("\n");
    if (flags.export) {
      exported.push({
        caseId: `c${exported.length + 1}`,
        sessionId,
        labels: Object.fromEntries(labelled.map((c) => [c.label, c.file])),
        prompt,
      });
      return;
    }
    try {
      const { object } = await generateObject({ model: judgeModel.model, schema: Grade, prompt, maxRetries: 2 });
      for (const c of labelled) {
        const grade = object.grades.find((g) => g.label.trim().toUpperCase() === c.label);
        // Keep earlier grades stable; only record runs that were not graded yet.
        if (grade && !cache[`${sessionId}|${c.file}`]) cache[`${sessionId}|${c.file}`] = grade;
      }
    } catch (error) {
      console.error(sessionId, error instanceof Error ? error.message.slice(0, 200) : error);
    }
    if (++done % 10 === 0) {
      console.log(`judged ${done}/${sessionIds.length}`);
      await Bun.write(cachePath, JSON.stringify(cache, null, 1));
    }
  });
  if (flags.export) {
    const size = Number(flags.export) || 15;
    const queue = `${dir}/judge-queue`;
    await mkdir(queue, { recursive: true });
    for (let i = 0; i * size < exported.length; i++) {
      const batch = exported.slice(i * size, (i + 1) * size);
      const name = `batch-${String(i + 1).padStart(2, "0")}`;
      // Graders only see prompts; the label -> run mapping stays in a separate file.
      await Bun.write(`${queue}/${name}.prompts.json`, JSON.stringify(batch.map(({ caseId, prompt }) => ({ caseId, prompt })), null, 1));
      await Bun.write(`${queue}/${name}.map.json`, JSON.stringify(batch.map(({ caseId, sessionId, labels }) => ({ caseId, sessionId, labels })), null, 1));
    }
    console.log(`exported ${exported.length} cases in ${Math.ceil(exported.length / size)} batches to ${queue}`);
    return;
  }
  await Bun.write(cachePath, JSON.stringify(cache, null, 1));
  await report(files);
}

// Merges grader answers written next to exported batches as <batch>.result.json:
// [{ caseId, grades: [{ label, score, missing, extra, wrongItem, portionOff, wrongMeal, junkText, note }] }]
async function judgeImport(files: string[]) {
  const { readdir } = await import("node:fs/promises");
  const queue = `${dir}/judge-queue`;
  const cachePath = `${dir}/${flags.cache}`;
  const cache: Record<string, unknown> = (await Bun.file(cachePath).exists()) ? await readJson(cachePath) : {};
  let merged = 0;
  for (const name of (await readdir(queue)).filter((f) => f.endsWith(".result.json"))) {
    const base = name.replace(".result.json", "");
    const map = new Map((await readJson<Array<{ caseId: string; sessionId: string; labels: Record<string, string> }>>(`${queue}/${base}.map.json`)).map((m) => [m.caseId, m]));
    for (const answer of await readJson<Array<{ caseId: string; grades: Array<{ label: string; score: number }> }>>(`${queue}/${name}`)) {
      const entry = map.get(answer.caseId);
      for (const grade of answer.grades ?? []) {
        const file = entry?.labels[grade.label.trim().toUpperCase()];
        if (file && !cache[`${entry!.sessionId}|${file}`] && typeof grade.score === "number") {
          cache[`${entry!.sessionId}|${file}`] = grade;
          merged++;
        }
      }
    }
  }
  await Bun.write(cachePath, JSON.stringify(cache, null, 1));
  console.log(`merged ${merged} grades`);
  await report(files);
}

async function report(files: string[]) {
  const cache: Record<string, { score: number; missing: number; extra: number; wrongItem: number; portionOff: number; wrongMeal: number; junkText: boolean }> =
    await readJson(flags.cache!);
  const rows = [];
  for (const file of files) {
    const run = await readJson<CaseResult[]>(file);
    const graded = run.map((r) => ({ r, g: cache[`${r.sessionId}|${file}`] })).filter((x) => x.g);
    const sum = (f: (g: (typeof graded)[number]["g"]) => number) => graded.reduce((a, x) => a + f(x.g!), 0);
    const ms = run.map((r) => r.ms).sort((a, b) => a - b);
    rows.push({
      run: file.replace(/^.*\//, "").replace(/\.json$/, ""),
      n: graded.length,
      score: +(sum((g) => g.score) / graded.length).toFixed(2),
      perfect: graded.filter((x) => x.g!.score >= 9).length,
      bad: graded.filter((x) => x.g!.score <= 4).length,
      missing: sum((g) => g.missing),
      extra: sum((g) => g.extra),
      wrongItem: sum((g) => g.wrongItem),
      portionOff: sum((g) => g.portionOff),
      wrongMeal: sum((g) => g.wrongMeal),
      junk: graded.filter((x) => x.g!.junkText).length,
      errors: run.filter((r) => r.error).length,
      p50ms: ms[Math.floor(ms.length / 2)],
      p90ms: ms[Math.floor(ms.length * 0.9)],
    });
  }
  console.table(rows);
  await Bun.write(`${dir}/report.json`, JSON.stringify(rows, null, 1));
}

if (command === "export") await exportSessions();
else if (command === "transcribe") await transcribe();
else if (command === "run") await run(positionals[1] ?? "meta/muse-wonder");
else if (command === "judge") await judge(positionals.slice(1).map((f) => (f.includes("/") ? f : `runs/${f}`)));
else if (command === "judge-import") await judgeImport(positionals.slice(1).map((f) => (f.includes("/") ? f : `runs/${f}`)));
else if (command === "report") await report(positionals.slice(1).map((f) => (f.includes("/") ? f : `runs/${f}`)));
else console.log("usage: bun scripts/ai-eval.ts export|transcribe|run <spec>|judge <runs...>|report <runs...>");
process.exit(0);
