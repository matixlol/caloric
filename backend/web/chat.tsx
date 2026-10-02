import { useEffect, useRef, useState } from "react";
import { createParser } from "eventsource-parser";
import type { Meal } from "@caloric/data-model";
import {
  api,
  label,
  makeEntry,
  totals,
  type Entry,
  type Food,
  type Snapshot,
} from "./model";
import { useOperation } from "./forms";
import {
  ErrorNotice,
  format,
  Icon,
  IconButton,
  MacroBadges,
  Sheet,
} from "./ui";
import type {
  AgentEvent,
  ResolvedApprovalSuggestion,
} from "../../mobile/src/ai/types";

type Suggestion = {
  id: string;
  food: Food;
  portion: number;
  meal: Meal;
  toolCallId?: string;
  saved?: boolean;
  skipped?: boolean;
};
type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  suggestions?: Suggestion[];
};

export function Assistant({
  open,
  snapshot,
  day,
  onSave,
  onClose,
}: {
  open: boolean;
  snapshot: Snapshot;
  day: string;
  onSave: (entry: Entry) => Promise<void>;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const session = useRef<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const abort = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const operation = useOperation();
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages, draft]);
  useEffect(
    () => () => {
      abort.current?.abort();
      if (recorder.current?.state === "recording") {
        recorder.current.onstop = null;
        recorder.current.stop();
      }
      stream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );
  useEffect(() => {
    if (!open && recorder.current?.state === "recording") {
      recorder.current.onstop = null;
      recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      setRecording(false);
    }
  }, [open]);
  async function send(message: string, audio?: Blob) {
    if ((!message.trim() && !audio) || operation.busy) return;
    setText("");
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: audio ? "Voice message" : message.trim(),
      },
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
      let turnId: string | null = null;
      let seq = -1;
      let terminal = false;
      let pendingText = "";
      function apply(event: AgentEvent, durable: boolean) {
        if (event.kind === "assistant-delta") {
          pendingText += event.text;
          setDraft(pendingText);
        } else if (event.kind === "assistant") {
          if (!durable) {
            pendingText = event.text;
            setDraft(pendingText);
          } else {
            setMessages((current) => [
              ...current,
              { id: crypto.randomUUID(), role: "assistant", text: event.text },
            ]);
            pendingText = "";
            setDraft("");
          }
        } else if (event.kind === "approval") {
          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text: "Check these foods before adding them.",
              suggestions: event.suggestions.map(
                (s: ResolvedApprovalSuggestion) => ({
                  id: s.suggestionId,
                  toolCallId: event.toolCallId,
                  food: s.food,
                  meal: s.meal,
                  portion: s.portion,
                }),
              ),
            },
          ]);
        }
      }
      async function consume(response: Response) {
        if (!response.ok) {
          const payload = await response.json();
          throw new Error(
            payload.message || payload.error || "Assistant request failed.",
          );
        }
        if (!response.body)
          throw new Error("The assistant returned an empty stream.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createParser({
          onEvent: ({ data }) => {
            if (data === "[DONE]") return;
            const payload = JSON.parse(data);
            if (payload.type === "turn") turnId = payload.turnId;
            if (typeof payload.seq === "number") {
              if (payload.seq <= seq) return;
              seq = payload.seq;
            }
            if (payload.type === "event")
              apply(payload.event, typeof payload.seq === "number");
            if (payload.type === "error") {
              terminal = true;
              throw new Error(
                payload.message || "The assistant could not finish.",
              );
            }
            if (payload.type === "status" && payload.status === "ready") {
              terminal = true;
              interruption = undefined;
            }
          },
        });
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              parser.feed(decoder.decode());
              break;
            }
            parser.feed(decoder.decode(value, { stream: true }));
          }
        } finally {
          await reader.cancel();
        }
      }
      let body: BodyInit;
      let headers: HeadersInit | undefined;
      if (audio) {
        const form = new FormData();
        form.append("sessionId", session.current!);
        form.append("actionType", "user-message");
        form.append(
          "audio",
          audio,
          audio.type.includes("mp4") ? "voice.mp4" : "voice.webm",
        );
        body = form;
      } else {
        headers = { "Content-Type": "application/json" };
        body = JSON.stringify({
          sessionId: session.current,
          action: { type: "user-message", message },
        });
      }
      let interruption: unknown;
      try {
        await consume(
          await fetch("/ai/turn", {
            method: "POST",
            credentials: "same-origin",
            headers,
            body,
            signal: controller.signal,
          }),
        );
      } catch (e) {
        interruption = e;
      }
      for (
        let retry = 0;
        !terminal && turnId && retry < 3 && !controller.signal.aborted;
        retry++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        pendingText = "";
        setDraft("");
        try {
          await consume(
            await fetch(
              `/ai/turn/${encodeURIComponent(turnId)}/stream?cursor=${seq}`,
              { credentials: "same-origin", signal: controller.signal },
            ),
          );
        } catch (e) {
          interruption = e;
        }
      }
      setDraft("");
      if (interruption && terminal) throw interruption;
      if (!terminal)
        throw new Error(
          "The connection was interrupted. Check your journal before sending again.",
        );
    });
  }
  async function decide(
    messageId: string,
    suggestion: Suggestion,
    approved: boolean,
  ) {
    await operation.run(async () => {
      if (approved) {
        const entry = makeEntry(
          suggestion.food,
          suggestion.meal,
          day,
          suggestion.portion,
          snapshot,
        );
        // A stable ID makes approval retries idempotent if a response is lost.
        entry.id = `food_web_${suggestion.id}`;
        await onSave(entry);
      }
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                suggestions: message.suggestions?.map((s) =>
                  s.id === suggestion.id
                    ? { ...s, saved: approved, skipped: !approved }
                    : s,
                ),
              }
            : message,
        ),
      );
      if (session.current && suggestion.toolCallId) {
        try {
          await api("/ai/turn", {
            sessionId: session.current,
            action: {
              type: "approval",
              toolCallId: suggestion.toolCallId,
              suggestionId: suggestion.id,
              approved,
            },
          });
        } catch {
          operation.setError(
            approved
              ? "Food saved. The assistant’s acknowledgement failed; don’t add it again."
              : "Skipped here, but the assistant’s acknowledgement failed.",
          );
        }
      }
    });
  }
  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      setRecording(false);
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
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
        void send("", new Blob(chunks, { type: mediaRecorder.mimeType }));
      };
      mediaRecorder.start();
      setRecording(true);
    } catch {
      stream.current?.getTracks().forEach((track) => track.stop());
      operation.setError(
        "Microphone unavailable. Allow microphone access or type your meal instead.",
      );
    }
  }
  if (!open) return null;
  return (
    <Sheet title="Food assistant" onClose={onClose}>
      <div className="chat-transcript" aria-live="polite">
        {messages.map((message) => (
          <div className={`chat-message ${message.role}`} key={message.id}>
            <span className="chat-role">
              {message.role === "user" ? "YOU" : "CALORIC"}
            </span>
            <p>{message.text}</p>
            {message.suggestions?.map((suggestion) => (
              <div className="approval-card" key={suggestion.id}>
                <div className="section-heading">
                  <strong>{suggestion.food.name}</strong>
                  <span>
                    {format(
                      (suggestion.food.nutrition?.calories || 0) *
                        suggestion.portion,
                    )}{" "}
                    kcal
                  </span>
                </div>
                <p>
                  {suggestion.portion} ×{" "}
                  {suggestion.food.serving || "1 serving"} ·{" "}
                  {label(suggestion.meal)}
                </p>
                <MacroBadges
                  nutrition={totals([
                    {
                      nutrition: suggestion.food.nutrition,
                      portion: suggestion.portion,
                    },
                  ])}
                />
                <div className="approval-actions">
                  {suggestion.saved ? (
                    <span className="saved-label">
                      <Icon name="check" size={16} />
                      Added to {label(suggestion.meal)}
                    </span>
                  ) : suggestion.skipped ? (
                    <span className="hint">Skipped</span>
                  ) : (
                    <>
                      <label className="approval-portion">
                        Servings
                        <input
                          type="number"
                          min="0.01"
                          max="1000"
                          step="any"
                          value={suggestion.portion}
                          onChange={(e) =>
                            setMessages((current) =>
                              current.map((m) =>
                                m.id === message.id
                                  ? {
                                      ...m,
                                      suggestions: m.suggestions?.map((s) =>
                                        s.id === suggestion.id
                                          ? {
                                              ...s,
                                              portion: Number(e.target.value),
                                            }
                                          : s,
                                      ),
                                    }
                                  : m,
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        className="text-button"
                        disabled={operation.busy}
                        onClick={() =>
                          void decide(message.id, suggestion, false)
                        }
                      >
                        Skip
                      </button>
                      <button
                        className="primary-button"
                        disabled={operation.busy || suggestion.portion <= 0}
                        onClick={() =>
                          void decide(message.id, suggestion, true)
                        }
                      >
                        Add food
                        <Icon name="plus" size={16} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
        {operation.busy && (
          <div className="chat-message assistant">
            <span className="chat-role">CALORIC</span>
            <p>{draft || "Working on it…"}</p>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <ErrorNotice message={operation.error} />
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input
          aria-label="Message Caloric"
          autoFocus
          placeholder={
            recording
              ? "Recording… tap stop to send"
              : "Message the food assistant"
          }
          disabled={recording}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {typeof MediaRecorder !== "undefined" && navigator.mediaDevices && (
          <IconButton
            name={recording ? "stop" : "mic"}
            title={
              recording ? "Stop recording and send" : "Record a voice message"
            }
            disabled={operation.busy}
            onClick={() => void toggleRecording()}
          />
        )}
        <button
          className="send-button"
          aria-label="Send message"
          disabled={operation.busy || recording || !text.trim()}
        >
          <Icon name="arrow" />
        </button>
      </form>
    </Sheet>
  );
}
