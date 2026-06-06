import { describe, it, expect, vi } from "vitest";
import { runConversion } from "./sseClient";
import type { PipelineEvent } from "../agent/events";

/** Build a 200 SSE Response whose body streams the given byte chunks. */
function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function frameBytes(event: PipelineEvent): Uint8Array {
  const text = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return new TextEncoder().encode(text);
}

const finalEvent: PipelineEvent = {
  type: "final_result",
  screenplay: {
    title: "红楼梦",
    logline: "宝黛初见",
    characters: [],
    locations: [],
    scenes: [],
  },
  yaml: "title: 红楼梦\n",
};

function collector() {
  const events: PipelineEvent[] = [];
  return { events, onEvent: (e: PipelineEvent) => events.push(e) };
}

describe("runConversion", () => {
  it("reassembles a multi-byte UTF-8 frame split across byte chunks (E5)", async () => {
    const bytes = frameBytes(finalEvent);
    const cut = 10; // mid multi-byte character, mid-frame
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        streamResponse([bytes.slice(0, cut), bytes.slice(cut)]),
      );
    const { events, onEvent } = collector();

    await runConversion("novel", undefined, { onEvent, fetchImpl });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(finalEvent);
  });

  it("forwards a normal multi-frame stream and synthesizes no error", async () => {
    const start: PipelineEvent = { type: "stage_start", stage: "chunk" };
    const done: PipelineEvent = { type: "stage_done", stage: "chunk" };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        streamResponse([frameBytes(start), frameBytes(done), frameBytes(finalEvent)]),
      );
    const { events, onEvent } = collector();

    await runConversion("novel", undefined, { onEvent, fetchImpl });

    expect(events).toEqual([start, done, finalEvent]);
  });

  it("converges a non-2xx response into one error event using its {error} body (E3)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "小说过长" }, { status: 413 }),
      );
    const { events, onEvent } = collector();

    await runConversion("x", undefined, { onEvent, fetchImpl });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect((events[0] as { message: string }).message).toBe("小说过长");
  });

  it("converges a fetch rejection into one error event (E3)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("network down"));
    const { events, onEvent } = collector();

    await runConversion("x", undefined, { onEvent, fetchImpl });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("converges a null body into one error event (E3)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const { events, onEvent } = collector();

    await runConversion("x", undefined, { onEvent, fetchImpl });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("converges a reader error into one error event (E3)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("read boom");
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(stream, { status: 200 }));
    const { events, onEvent } = collector();

    await runConversion("x", undefined, { onEvent, fetchImpl });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("converges a malformed SSE frame (SSEProtocolError) into one error event (E3/E6)", async () => {
    const bad = new TextEncoder().encode("event: error\ndata: {bad}\n\n");
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([bad]));
    const { events, onEvent } = collector();

    await runConversion("x", undefined, { onEvent, fetchImpl });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("synthesizes an error when the stream ends without final_result (E3)", async () => {
    const start: PipelineEvent = { type: "stage_start", stage: "scenes", total: 2 };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(streamResponse([frameBytes(start)]));
    const { events, onEvent } = collector();

    await runConversion("x", undefined, { onEvent, fetchImpl });

    expect(events[0]).toEqual(start);
    expect(events[events.length - 1].type).toBe("error");
  });

  it("stays silent on AbortError (user cancel) — no error event (E3)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchImpl = vi.fn().mockRejectedValue(abortErr);
    const { events, onEvent } = collector();

    await runConversion("x", undefined, { onEvent, fetchImpl });

    expect(events).toEqual([]);
  });
});
