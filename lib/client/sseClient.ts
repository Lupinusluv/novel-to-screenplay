/**
 * Fetch streaming client for `POST /api/convert`. The route streams SSE, but the
 * native `EventSource` only supports GET, so we must POST with `fetch` and read
 * `res.body` manually — decoding bytes with a streaming `TextDecoder` and slicing
 * frames with `SSEFrameParser`.
 *
 * Failure convergence (E3): every failure surface — non-2xx, fetch rejection,
 * null body, a reader/throw, a malformed frame (`SSEProtocolError`, E6), or the
 * stream ending before `final_result` — is funnelled into a single synthesized
 * `error` event so the UI has exactly one place to react. The lone exception is
 * `AbortError` (user cancel, E4): it resolves silently with no error event.
 *
 * E5: a multi-byte UTF-8 character (Chinese, YAML) can be split across two
 * `Uint8Array` chunks. `TextDecoder({stream:true})` buffers the partial bytes;
 * the final `decode()` flushes any remainder. Only decoded strings reach the
 * parser.
 *
 * E10 discipline: `import type` only — no agent runtime / fs / env in this
 * client-bound module.
 */

import { SSEFrameParser } from "../sse/parseSSE";
import type { PipelineEvent } from "../agent/events";

export interface RunConversionDeps {
  onEvent: (event: PipelineEvent) => void;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const CONVERT_URL = "/api/convert";

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error && err.name === "AbortError"
  );
}

function errorEvent(message: string): PipelineEvent {
  // Pre-stream / transport failures aren't tied to a real stage; attribute to
  // the first stage so the timeline surfaces the message. No `sceneId` ⇒ the
  // reducer treats it as fatal (E1).
  return { type: "error", stage: "chunk", message };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runConversion(
  novel: string,
  options: Record<string, unknown> | undefined,
  { onEvent, signal, fetchImpl = fetch }: RunConversionDeps,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(CONVERT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ novel, ...(options ? { options } : {}) }),
      signal,
    });
  } catch (err) {
    if (isAbort(err)) return; // user cancel → silent
    onEvent(errorEvent(`请求失败：${describe(err)}`));
    return;
  }

  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    onEvent(errorEvent(message));
    return;
  }

  if (!res.body) {
    onEvent(errorEvent("响应没有可读的数据流"));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SSEFrameParser();
  let sawFinal = false;

  const emit = (events: PipelineEvent[]) => {
    for (const ev of events) {
      if (ev.type === "final_result") sawFinal = true;
      onEvent(ev);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      emit(parser.feed(decoder.decode(value, { stream: true })));
    }
    const tail = decoder.decode(); // flush any buffered multi-byte remainder
    if (tail) emit(parser.feed(tail));
  } catch (err) {
    if (isAbort(err)) return; // mid-stream cancel → silent
    onEvent(errorEvent(`转换中断：${describe(err)}`));
    return;
  }

  if (!sawFinal) {
    onEvent(errorEvent("转换中断：未收到最终结果"));
  }
}
