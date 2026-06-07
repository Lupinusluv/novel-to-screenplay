/**
 * OpenAI-compatible LLM client.
 *
 * Provider-agnostic: point `baseUrl` at any `/chat/completions` endpoint
 * (DeepSeek, OpenAI, 智谱, a local model, ...). Uses the built-in `fetch`,
 * so it has no SDK dependency. `fetchImpl` is injectable for testing.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface LLMConfig {
  /** Base URL including version, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Per-request timeout. Default 60s. */
  timeoutMs?: number;
  /** Number of retries on transient failures. Default 2. */
  maxRetries?: number;
  /** Base backoff delay between retries (ms). Default 500. Set 0 in tests. */
  retryBaseDelayMs?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  /** Ask the provider for a JSON object response (best-effort). */
  json?: boolean;
  /** External abort signal, combined with the internal timeout. */
  signal?: AbortSignal;
}

export interface LLMClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  chatJSON<T = unknown>(messages: ChatMessage[], opts?: ChatOptions): Promise<T>;
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Stable, machine-readable error classes the UI can react to without parsing a
 *  formatted message string. Currently just balance exhaustion (the one failure
 *  a public demo, burning the author's own key, will realistically hit). */
export type LLMErrorCode = "insufficient_balance";

/**
 * A typed LLM failure carrying the raw HTTP `status` and, when recognised, a
 * structured `code`. Classification happens here — the one place that sees both
 * the status and the original body — so nothing downstream has to regex an
 * already-formatted error message.
 */
export class LLMError extends Error {
  status?: number;
  code?: LLMErrorCode;
  constructor(
    message: string,
    opts: { status?: number; code?: LLMErrorCode } = {},
  ) {
    super(message);
    this.name = "LLMError";
    this.status = opts.status;
    this.code = opts.code;
  }
}

/**
 * Map an HTTP status + raw response body to a structured error code.
 * Primary signal is `402 Payment Required` (DeepSeek returns this when the key
 * runs out of balance). The body regex is a fallback for providers that report
 * balance exhaustion under a different status — matched against the *raw* body
 * (so a nested `{"error":{"message":"Insufficient Balance"}}` is caught too),
 * never against a downstream-formatted message. NOTE: a blanket 402 → balance
 * mapping is a demo-friendly heuristic, not the full semantics of every
 * provider's 402; the raw `status` is preserved on LLMError for diagnostics.
 */
export function classifyLLMErrorCode(
  status: number,
  body: string,
): LLMErrorCode | undefined {
  if (status === 402) return "insufficient_balance";
  if (/insufficient\s+balance|余额不足/i.test(body)) return "insufficient_balance";
  return undefined;
}

/** Read the structured code off an unknown error (undefined if not an LLMError
 *  or unclassified). Walks the `cause` chain so an LLMError wrapped by an agent
 *  (e.g. "StoryBible map failed: …", { cause }) is still recognised. Lets the
 *  orchestrator forward the code without `instanceof` noise at every call site. */
export function llmErrorCode(err: unknown): LLMErrorCode | undefined {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 10; depth++) {
    if (cur instanceof LLMError) return cur.code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Robustly pull a JSON value out of an LLM response that may wrap it in
 * markdown fences or surround it with prose.
 */
export function extractJSON(text: string): unknown {
  const trimmed = text.trim();

  // 1) Whole string is JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // 2) Fenced code block (```json ... ``` or ``` ... ```).
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }

  // 3) First balanced-looking object/array embedded in prose.
  const candidate = sliceFirstJsonLike(trimmed);
  if (candidate) {
    return JSON.parse(candidate);
  }

  throw new Error(
    `Could not extract JSON from LLM response: ${truncate(trimmed, 200)}`,
  );
}

function sliceFirstJsonLike(text: string): string | null {
  const start = firstIndexOfAny(text, ["{", "["]);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function firstIndexOfAny(text: string, chars: string[]): number {
  const indexes = chars
    .map((c) => text.indexOf(c))
    .filter((i) => i !== -1);
  return indexes.length ? Math.min(...indexes) : -1;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const delay = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

export function createLLMClient(config: LLMConfig): LLMClient {
  const {
    baseUrl,
    apiKey,
    model,
    timeoutMs = 60_000,
    maxRetries = 2,
    retryBaseDelayMs = 500,
    fetchImpl = fetch,
  } = config;

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  async function chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      model: opts.model ?? model,
      messages,
    };
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    if (opts.json) payload.response_format = { type: "json_object" };

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      const signal = mergeSignals(timeout.signal, opts.signal);
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal,
        });

        if (!res.ok) {
          const text = await safeText(res);
          if (TRANSIENT_STATUS.has(res.status) && attempt < maxRetries) {
            lastError = new Error(`LLM ${res.status}: ${truncate(text, 200)}`);
            await delay(retryBaseDelayMs * 2 ** attempt);
            continue;
          }
          // Non-transient (or last-attempt transient) HTTP failure. Keep the
          // `LLM request failed <status>:` message format (isRetryable's legacy
          // regex still matches) AND tag it structurally so the UI can react.
          throw new LLMError(
            `LLM request failed ${res.status}: ${truncate(text, 200)}`,
            { status: res.status, code: classifyLLMErrorCode(res.status, text) },
          );
        }

        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new Error("LLM response missing choices[0].message.content");
        }
        return content;
      } catch (err) {
        lastError = err;
        // Network/abort errors are retryable until the budget is exhausted.
        if (attempt < maxRetries && isRetryable(err)) {
          await delay(retryBaseDelayMs * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("LLM request failed");
  }

  async function chatJSON<T = unknown>(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<T> {
    const text = await chat(messages, { ...opts, json: opts.json ?? true });
    return extractJSON(text) as T;
  }

  return { chat, chatJSON };
}

function isRetryable(err: unknown): boolean {
  // A typed LLMError is always a final HTTP failure (402/401/…) — never retry it
  // (a 402 in particular must not burn extra calls). Explicit check decouples
  // from the message format below.
  if (err instanceof LLMError) return false;
  // Legacy: errors thrown for non-transient HTTP status are not retried. Network
  // errors (no such message) land here and are retryable.
  if (err instanceof Error) {
    return !/LLM request failed \d/.test(err.message);
  }
  return false;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function mergeSignals(
  a: AbortSignal,
  b?: AbortSignal,
): AbortSignal {
  if (!b) return a;
  if (typeof (AbortSignal as { any?: unknown }).any === "function") {
    return (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([
      a,
      b,
    ]);
  }
  return a;
}

export function loadLLMConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): LLMConfig {
  let baseUrl = env.LLM_BASE_URL;
  let apiKey = env.LLM_API_KEY;
  let model = env.LLM_MODEL;

  // DeepSeek fallback: only when *none* of the explicit LLM_* are set and a
  // DEEPSEEK_API_KEY is present. A *partial* LLM_* config falls through to the
  // missing-vars error below rather than silently falling back (I8) — mixing a
  // half-specified endpoint with DeepSeek defaults would be a surprising trap.
  if (!baseUrl && !apiKey && !model && env.DEEPSEEK_API_KEY) {
    baseUrl = "https://api.deepseek.com";
    apiKey = env.DEEPSEEK_API_KEY;
    model = "deepseek-chat";
  }

  const missing = [
    !baseUrl && "LLM_BASE_URL",
    !apiKey && "LLM_API_KEY",
    !model && "LLM_MODEL",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Missing required LLM env var(s): ${missing.join(", ")}. ` +
        `See .env.example.`,
    );
  }
  return {
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    model: model!,
    timeoutMs: numEnv(env.LLM_TIMEOUT_MS),
    maxRetries: numEnv(env.LLM_MAX_RETRIES),
  };
}

function numEnv(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
