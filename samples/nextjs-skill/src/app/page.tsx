"use client";

import { useState } from "react";

type Turn = {
  role: "user" | "assistant";
  text: string;
  raw?: unknown;
};

const EXAMPLES: Array<{ label: string; prompt: string; hint: string }> = [
  {
    label: "Weather skill",
    prompt: "What's the weather in Seoul?",
    hint: "Should trigger weather-report → load_skill → read_skill_file(REFERENCE.md) → run_skill_script(scripts/forecast.sh)",
  },
  {
    label: "Recipe skill",
    prompt: "I have chicken, rice, garlic, and soy sauce. What can I cook?",
    hint: "Should trigger recipe-suggest → load_skill → read_skill_file(FORMS.md)",
  },
  {
    label: "Math skill (inline)",
    prompt: "What is 347 * 29 + 128?",
    hint: "Should trigger math-helper (defineSkill, inline) — no file reads, no script.",
  },
  {
    label: "No skill",
    prompt: "Hi, who are you?",
    hint: "A generic greeting shouldn't trigger any skill — baseline sanity check.",
  },
];

export default function HomePage() {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  async function send(text: string) {
    const userText = text.trim();
    if (!userText || loading) return;
    setTurns((prev) => [...prev, { role: "user", text: userText }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "message/send",
          params: {
            message: {
              messageId: `msg-${Date.now()}`,
              role: "user",
              parts: [{ text: userText }],
            },
          },
        }),
      });
      const json: unknown = await res.json();
      setTurns((prev) => [
        ...prev,
        { role: "assistant", text: extractAssistantText(json) ?? "(no text found — see raw)", raw: json },
      ]);
    } catch (err) {
      setTurns((prev) => [
        ...prev,
        { role: "assistant", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="w-full max-w-4xl mx-auto flex-1 flex flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">A2X Skills Demo</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Exercises the Claude Agent Skills runtime integrated into{" "}
          <span className="font-mono">@a2x/sdk</span>. Use one of the example prompts below or type your own.
        </p>
        <div className="flex flex-wrap gap-2 text-xs font-mono">
          <a className="underline" href="/.well-known/agent.json" target="_blank" rel="noreferrer">
            /.well-known/agent.json
          </a>
          <span className="text-zinc-400">·</span>
          <a className="underline" href="/.well-known/agent-card.json" target="_blank" rel="noreferrer">
            /.well-known/agent-card.json
          </a>
          <span className="text-zinc-400">·</span>
          <span>POST /api/a2a</span>
        </div>
      </header>

      <section className="grid sm:grid-cols-2 gap-3">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            type="button"
            onClick={() => send(ex.prompt)}
            disabled={loading}
            className="text-left rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 py-3 hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50"
          >
            <div className="text-sm font-semibold">{ex.label}</div>
            <div className="text-sm text-zinc-700 dark:text-zinc-300 mt-1 font-mono">{ex.prompt}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1.5">{ex.hint}</div>
          </button>
        ))}
      </section>

      <section className="flex flex-col gap-3 min-h-[200px]">
        {turns.length === 0 && (
          <div className="text-sm text-zinc-400 italic">No messages yet — pick an example or type below.</div>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={
              t.role === "user"
                ? "self-end max-w-[80%] rounded-lg bg-blue-100 dark:bg-blue-900/40 px-4 py-2 text-sm"
                : "self-start max-w-[80%] rounded-lg bg-zinc-100 dark:bg-zinc-900 px-4 py-2 text-sm whitespace-pre-wrap font-mono"
            }
          >
            {t.text}
            {t.role === "assistant" && showRaw && t.raw ? (
              <pre className="mt-2 overflow-x-auto text-[10px] text-zinc-500 border-t border-zinc-300 dark:border-zinc-700 pt-2">
                {JSON.stringify(t.raw, null, 2)}
              </pre>
            ) : null}
          </div>
        ))}
        {loading ? (
          <div className="self-start text-xs text-zinc-500">…thinking (check server logs for skill audit events)</div>
        ) : null}
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex gap-2 sticky bottom-0 bg-inherit py-3 border-t border-zinc-200 dark:border-zinc-800"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask something..."
          className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-md bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Send
        </button>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs"
        >
          {showRaw ? "Hide raw" : "Show raw"}
        </button>
      </form>
    </main>
  );
}

function extractAssistantText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const body = response as Record<string, unknown>;
  const result = body.result;
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  const directParts = Array.isArray(r.parts) ? (r.parts as Array<Record<string, unknown>>) : null;
  if (directParts) {
    const textParts = directParts.map((p) => (typeof p.text === "string" ? p.text : "")).filter(Boolean);
    if (textParts.length) return textParts.join("");
  }

  const status = r.status as Record<string, unknown> | undefined;
  const statusMsg = status?.message as Record<string, unknown> | undefined;
  const statusParts = Array.isArray(statusMsg?.parts)
    ? (statusMsg.parts as Array<Record<string, unknown>>)
    : null;
  if (statusParts) {
    const textParts = statusParts.map((p) => (typeof p.text === "string" ? p.text : "")).filter(Boolean);
    if (textParts.length) return textParts.join("");
  }

  const artifacts = Array.isArray(r.artifacts) ? (r.artifacts as Array<Record<string, unknown>>) : null;
  if (artifacts) {
    const texts: string[] = [];
    for (const a of artifacts) {
      const parts = Array.isArray(a.parts) ? (a.parts as Array<Record<string, unknown>>) : null;
      if (!parts) continue;
      for (const p of parts) {
        if (typeof p.text === "string") texts.push(p.text);
      }
    }
    if (texts.length) return texts.join("\n");
  }

  return null;
}
