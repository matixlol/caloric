import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { Meal } from "@caloric/data-model";
import { api, label, makeEntry, meals, totals, type Entry, type Food, type Snapshot } from "./model";
import { useOperation } from "./forms";
import { decimal, ErrorNotice, format, Icon, IconButton, MacroBadges, Sheet } from "./ui";
import {
  imageFiles,
  maxAttachments,
  prepareImage,
  streamTurn,
  type Attachment,
} from "./assistant";
import type { AgentEvent, ResolvedApprovalSuggestion } from "../../mobile/src/ai/types";

type Item = {
  id: string;
  food: Food;
  portion: number;
  meal: Meal;
  reason: string;
  state: "pending" | "saved" | "skipped";
};
type Message =
  | { id: string; kind: "user"; text: string; images: string[]; voice?: boolean }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "search"; query: string; foods: Food[] }
  | { id: string; kind: "approval"; items: Item[] };

export type AssistantLaunch = { files?: File[]; record?: boolean; key: number };

const examples = [
  "2 eggs and a slice of toast for breakfast",
  "180 g chicken breast and rice for lunch",
  "A medium latte with oat milk",
];

const kcal = (item: Pick<Item, "food" | "portion">) => (item.food.nutrition?.calories || 0) * item.portion;

export function Assistant({
  open,
  launch,
  snapshot,
  day,
  onSaveMany,
  onClose,
}: {
  open: boolean;
  launch: AssistantLaunch | null;
  snapshot: Snapshot;
  day: string;
  onSaveMany: (entries: Entry[]) => Promise<void>;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [activity, setActivity] = useState("Thinking…");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [recording, setRecording] = useState(false);
  const [dragging, setDragging] = useState(false);
  const session = useRef<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const abort = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  // Voice notes finish asynchronously; read the latest attachments at send time.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const operation = useOperation();
  const saving = useOperation();

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, draft, operation.busy]);
  useEffect(
    () => () => {
      abort.current?.abort();
      stopRecorder();
      urls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );
  useEffect(() => {
    if (!open) stopRecorder();
  }, [open]);
  useEffect(() => {
    if (!open || !launch) return;
    if (launch.files?.length) void attach(launch.files);
    if (launch.record) void toggleRecording();
  }, [launch?.key]);
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 140)}px`;
  }, [text, open]);

  function stopRecorder() {
    if (recorder.current?.state === "recording") {
      recorder.current.onstop = null;
      recorder.current.stop();
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    setRecording(false);
  }

  async function attach(files: File[]) {
    const images = imageFiles(files);
    if (!images.length) {
      operation.setError("Only photos can be attached.");
      return;
    }
    const room = maxAttachments - attachments.length;
    if (images.length > room) operation.setError(`You can attach up to ${maxAttachments} photos per message.`);
    try {
      const prepared = await Promise.all(images.slice(0, Math.max(0, room)).map(prepareImage));
      urls.current.push(...prepared.map((item) => item.url));
      setAttachments((current) => [...current, ...prepared].slice(0, maxAttachments));
      input.current?.focus();
    } catch (error) {
      operation.setError(error instanceof Error ? error.message : "Could not read that photo.");
    }
  }

  function updateItem(messageId: string, itemId: string, patch: Partial<Item>) {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId && message.kind === "approval"
          ? { ...message, items: message.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)) }
          : message,
      ),
    );
  }

  async function save(messageId: string, items: Item[]) {
    await saving.run(async () => {
      let sortSnapshot = snapshot;
      const entries = items.map((item) => {
        const entry = makeEntry(item.food, item.meal, day, item.portion, sortSnapshot);
        // A stable ID makes retries idempotent if a response is lost.
        entry.id = `food_web_${item.id}`;
        sortSnapshot = { ...sortSnapshot, entries: [...sortSnapshot.entries, entry] };
        return entry;
      });
      await onSaveMany(entries);
      for (const item of items) updateItem(messageId, item.id, { state: "saved" });
    });
  }

  async function send(message: string, audio?: Blob) {
    const photos = attachmentsRef.current;
    if ((!message.trim() && !audio && !photos.length) || operation.busy) return;
    setText("");
    setAttachments([]);
    setDraft("");
    setActivity(audio ? "Listening to your note…" : photos.length ? "Looking at your photo…" : "Thinking…");
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: "user", text: message.trim(), images: photos.map((photo) => photo.url), voice: Boolean(audio) },
    ]);
    await operation.run(async () => {
      if (!session.current)
        session.current = (
          await api<{ sessionId: string }>("/ai/session", {
            recentLogs: snapshot.entries.slice(-80).map((row) => row.data),
          })
        ).sessionId;
      const controller = new AbortController();
      abort.current = controller;
      let pending = "";
      const form = new FormData();
      form.append("sessionId", session.current);
      form.append("actionType", "user-message");
      if (message.trim()) form.append("message", message.trim());
      photos.forEach((photo, index) =>
        form.append("image", photo.blob, `photo-${index + 1}.${photo.blob.type === "image/jpeg" ? "jpg" : photo.blob.type.split("/")[1] || "jpg"}`),
      );
      // The server decodes whatever the browser recorded (WebM or MP4).
      if (audio) form.append("audio", audio, audio.type.includes("mp4") ? "voice.mp4" : "voice.webm");
      const apply = (event: AgentEvent, durable: boolean) => {
        if (event.kind === "assistant-delta") {
          pending += event.text;
          setDraft(pending);
        } else if (event.kind === "assistant") {
          pending = durable ? "" : event.text;
          setDraft(pending);
          if (durable) setMessages((current) => [...current, { id: crypto.randomUUID(), kind: "assistant", text: event.text }]);
        } else if (event.kind === "search") {
          const query = event.query ?? "foods";
          setActivity(`Searching “${query}”…`);
          setMessages((current) => [...current, { id: crypto.randomUUID(), kind: "search", query, foods: event.foods }]);
        } else if (event.kind === "approval") {
          setActivity("Preparing suggestions…");
          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              kind: "approval",
              items: event.suggestions.map((s: ResolvedApprovalSuggestion) => ({
                id: s.suggestionId,
                food: s.food,
                meal: s.meal,
                portion: s.portion,
                reason: s.reason,
                state: "pending" as const,
              })),
            },
          ]);
        }
      };
      try {
        await streamTurn({ body: form, signal: controller.signal, onEvent: apply });
      } finally {
        setDraft("");
      }
    });
  }

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      setRecording(false);
      return;
    }
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices) {
      operation.setError("Voice notes are not supported in this browser.");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!openRef.current) {
        stream.current.getTracks().forEach((track) => track.stop());
        return;
      }
      const mediaRecorder = new MediaRecorder(stream.current);
      recorder.current = mediaRecorder;
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        stream.current?.getTracks().forEach((track) => track.stop());
        void send(input.current?.value ?? "", new Blob(chunks, { type: mediaRecorder.mimeType }));
      };
      mediaRecorder.start();
      setRecording(true);
    } catch {
      stream.current?.getTracks().forEach((track) => track.stop());
      operation.setError("Microphone unavailable. Allow microphone access or type your meal instead.");
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void attach(Array.from(event.dataTransfer.files));
  }
  function onPaste(event: ClipboardEvent) {
    const files = imageFiles(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void attach(files);
  }

  if (!open) return null;
  const busy = operation.busy;
  const canSend = !busy && !recording && (text.trim().length > 0 || attachments.length > 0);
  return (
    <Sheet title="Assistant" subtitle="Log food by typing, talking or snapping a photo" onClose={onClose} fixedHeight>
      <div
        className={`ax ${dragging ? "ax-dragging" : ""}`}
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes("Files")) setDragging(true);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div className="ax-transcript" aria-live="polite">
          {messages.length === 0 && !busy && (
            <div className="ax-welcome">
              <span className="ax-orb" aria-hidden="true">
                <Icon name="spark" size={26} />
              </span>
              <h3>What did you eat?</h3>
              <p>Describe it, hold a voice note, or add a photo of your plate or a nutrition label. You review everything before it’s logged.</p>
              <div className="ax-examples">
                {examples.map((example) => (
                  <button key={example} type="button" onClick={() => void send(example)}>
                    {example}
                    <Icon name="arrow" size={16} />
                  </button>
                ))}
                <button type="button" onClick={() => fileInput.current?.click()}>
                  Snap or choose a photo of your meal
                  <Icon name="image" size={16} />
                </button>
              </div>
            </div>
          )}
          {messages.map((message) => {
            if (message.kind === "user")
              return (
                <div className="ax-user" key={message.id}>
                  {message.images.length > 0 && (
                    <div className={`ax-user-images count-${message.images.length}`}>
                      {message.images.map((url) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer">
                          <img src={url} alt="Attached photo" />
                        </a>
                      ))}
                    </div>
                  )}
                  {(message.text || message.voice) && (
                    <p className="ax-bubble">
                      {message.voice && (
                        <span className="ax-voice">
                          <Icon name="mic" size={15} />
                          Voice note
                        </span>
                      )}
                      {message.text}
                    </p>
                  )}
                </div>
              );
            if (message.kind === "assistant")
              return (
                <p className="ax-assistant" key={message.id}>
                  {message.text}
                </p>
              );
            if (message.kind === "search")
              return (
                <details className="ax-search" key={message.id}>
                  <summary>
                    <Icon name="search" size={14} />
                    <span>
                      Searched <strong>{message.query}</strong>
                    </span>
                    <small>
                      {message.foods.length} {message.foods.length === 1 ? "result" : "results"}
                    </small>
                  </summary>
                  <ul>
                    {message.foods.map((food) => (
                      <li key={food.id}>
                        <span>
                          {food.name}
                          {food.brand && <small> · {food.brand}</small>}
                        </span>
                        <small>
                          {format(food.nutrition?.calories)} kcal / {food.serving || "serving"}
                        </small>
                      </li>
                    ))}
                  </ul>
                </details>
              );
            const pending = message.items.filter((item) => item.state === "pending");
            const total = message.items.filter((item) => item.state !== "skipped").reduce((sum, item) => sum + kcal(item), 0);
            return (
              <section className="ax-suggestions" key={message.id} aria-label="Suggested foods">
                <header>
                  <span>
                    {pending.length === 0
                      ? "Reviewed"
                      : `${pending.length === 1 ? "1 food" : `${pending.length} foods`} to review`}
                  </span>
                  <strong>{format(total)} kcal</strong>
                </header>
                {message.items.map((item) => (
                  <article className={`ax-card ${item.state}`} key={item.id}>
                    <div className="ax-card-head">
                      <div>
                        <strong>{item.food.name}</strong>
                        <span>{[item.food.brand, item.food.serving].filter(Boolean).join(" · ") || "1 serving"}</span>
                      </div>
                      <div className="ax-kcal">
                        <b>{format(kcal(item))}</b>
                        <small>kcal</small>
                      </div>
                    </div>
                    <MacroBadges nutrition={{ ...totals([{ nutrition: item.food.nutrition, portion: item.portion }]), calories: undefined }} />
                    {item.reason && <p className="ax-reason">{item.reason}</p>}
                    {item.state === "pending" ? (
                      <div className="ax-card-controls">
                        <div className="ax-stepper" role="group" aria-label={`Servings of ${item.food.name}`}>
                          <IconButton
                            name="minus"
                            title="Fewer servings"
                            disabled={item.portion <= 0.25}
                            onClick={() => updateItem(message.id, item.id, { portion: Math.max(0.25, item.portion - 0.25) })}
                          />
                          <span>
                            <b>{decimal(item.portion)}</b> {item.portion === 1 ? "serving" : "servings"}
                          </span>
                          <IconButton
                            name="plus"
                            title="More servings"
                            onClick={() => updateItem(message.id, item.id, { portion: item.portion + 0.25 })}
                          />
                        </div>
                        <select
                          className="ax-meal"
                          aria-label={`Meal for ${item.food.name}`}
                          value={item.meal}
                          onChange={(e) => updateItem(message.id, item.id, { meal: e.target.value as Meal })}
                        >
                          {meals.map((meal) => (
                            <option key={meal} value={meal}>
                              {label(meal)}
                            </option>
                          ))}
                        </select>
                        <div className="ax-card-actions">
                          <button type="button" className="text-button" onClick={() => updateItem(message.id, item.id, { state: "skipped" })}>
                            Skip
                          </button>
                          <button type="button" className="primary-button" disabled={saving.busy} onClick={() => void save(message.id, [item])}>
                            Add
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className={`ax-card-state ${item.state}`}>
                        {item.state === "saved" ? (
                          <>
                            <Icon name="check" size={15} /> Added to {label(item.meal)}
                          </>
                        ) : (
                          <>
                            Skipped
                            <button type="button" className="text-button" onClick={() => updateItem(message.id, item.id, { state: "pending" })}>
                              Undo
                            </button>
                          </>
                        )}
                      </p>
                    )}
                  </article>
                ))}
                {pending.length > 1 && (
                  <button type="button" className="primary-button ax-add-all" disabled={saving.busy} onClick={() => void save(message.id, pending)}>
                    <Icon name="check" size={17} />
                    Add all {pending.length} · {format(pending.reduce((sum, item) => sum + kcal(item), 0))} kcal
                  </button>
                )}
              </section>
            );
          })}
          {busy && (
            <>
              {draft && <p className="ax-assistant">{draft}</p>}
              <div className="ax-activity" role="status">
                <span className="ax-pulse" aria-hidden="true" />
                {activity}
              </div>
            </>
          )}
          <div ref={bottom} />
        </div>
        <ErrorNotice message={operation.error || saving.error} />
        <form
          className="ax-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) void send(text);
          }}
        >
          {attachments.length > 0 && (
            <div className="ax-attachments">
              {attachments.map((attachment) => (
                <div className="ax-thumb" key={attachment.id}>
                  <img src={attachment.url} alt="Photo to send" />
                  <button
                    type="button"
                    aria-label="Remove photo"
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="ax-composer-row">
            <IconButton
              name="image"
              title="Add photos"
              className="ax-attach"
              disabled={busy || attachments.length >= maxAttachments}
              onClick={() => fileInput.current?.click()}
            />
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void attach(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <textarea
              ref={input}
              rows={1}
              aria-label="Message Caloric"
              placeholder={recording ? "Recording… tap stop to send" : attachments.length ? "Add a note (optional)" : "What did you eat?"}
              disabled={recording}
              value={text}
              onPaste={onPaste}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (canSend) void send(text);
                }
              }}
            />
            {canSend ? (
              <button className="send-button" aria-label="Send message">
                <Icon name="arrow" />
              </button>
            ) : (
              <IconButton
                name={recording ? "stop" : "mic"}
                title={recording ? "Stop recording and send" : "Record a voice note"}
                className={`ax-mic ${recording ? "recording" : ""}`}
                disabled={busy}
                onClick={() => void toggleRecording()}
              />
            )}
          </div>
        </form>
        {dragging && (
          <div className="ax-drop" aria-hidden="true">
            <Icon name="image" size={30} />
            Drop photos to attach
          </div>
        )}
      </div>
    </Sheet>
  );
}
