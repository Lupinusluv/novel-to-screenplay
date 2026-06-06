/**
 * SSE frame parser (client side). Pure + stateful buffer: `feed(text)` takes an
 * already-decoded string chunk and returns the `PipelineEvent`s whose frames are
 * now complete. Byte-boundary concerns (multi-byte UTF-8 split across chunks)
 * are the caller's job via `TextDecoder({stream:true})` — this parser only ever
 * sees strings.
 *
 * Frame shape (from `lib/agent/sse.ts`): `event: <type>\ndata: <json>\n\n`. We
 * read the `data:` line(s) and `JSON.parse` them; the `event:` line is redundant
 * because the payload carries its own `type`. A malformed frame throws a typed
 * `SSEProtocolError` (E6) rather than being silently dropped, so lost events are
 * diagnosable.
 *
 * E10 discipline: only `import type` from the schema/events layer — never pull
 * `lib/agent/*` runtime, fs, or env into this client-bound module.
 */

import type { PipelineEvent } from "../agent/events";

/** Typed protocol error (E6): a frame could not be parsed into an event. */
export class SSEProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSEProtocolError";
  }
}

export class SSEFrameParser {
  private buffer = "";

  /**
   * Feed a decoded string chunk; returns every event whose frame is now
   * complete. A partial trailing frame stays buffered for the next call.
   */
  feed(text: string): PipelineEvent[] {
    // Normalise CRLF terminators so a single `\n\n` split rule works.
    this.buffer = (this.buffer + text).replace(/\r\n/g, "\n");

    const events: PipelineEvent[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const rawFrame = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);

      // Skip wholly-empty frames produced by back-to-back terminators.
      if (rawFrame.trim() === "") continue;

      events.push(parseFrame(rawFrame));
    }
    return events;
  }
}

/** Parse one frame's lines into a `PipelineEvent`, or throw `SSEProtocolError`. */
function parseFrame(rawFrame: string): PipelineEvent {
  const dataLines: string[] = [];
  for (const line of rawFrame.split("\n")) {
    if (line.startsWith("data:")) {
      // Strip `data:` and a single optional leading space (SSE convention).
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }

  if (dataLines.length === 0) {
    throw new SSEProtocolError(`SSE frame has no data line: ${rawFrame}`);
  }
  const data = dataLines.join("\n");
  if (data === "") {
    throw new SSEProtocolError("SSE frame has an empty data value");
  }

  try {
    return JSON.parse(data) as PipelineEvent;
  } catch {
    throw new SSEProtocolError(`SSE frame data is not valid JSON: ${data}`);
  }
}
