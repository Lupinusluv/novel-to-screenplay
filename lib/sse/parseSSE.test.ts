import { describe, it, expect } from "vitest";
import { SSEFrameParser, SSEProtocolError } from "./parseSSE";
import type { PipelineEvent } from "../agent/events";

/** Encode like the backend's `eventToSSE` (lib/agent/sse.ts) for fixtures. */
function frame(event: PipelineEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const startScenes: PipelineEvent = {
  type: "stage_start",
  stage: "scenes",
  total: 3,
};
const doneScenes: PipelineEvent = { type: "stage_done", stage: "scenes" };

describe("SSEFrameParser.feed", () => {
  it("reassembles one frame split across two chunks into a single event", () => {
    const whole = frame(startScenes);
    const cut = Math.floor(whole.length / 2);
    const parser = new SSEFrameParser();

    const first = parser.feed(whole.slice(0, cut));
    expect(first).toEqual([]); // half a frame yields nothing yet

    const second = parser.feed(whole.slice(cut));
    expect(second).toEqual([startScenes]);
  });

  it("emits multiple events when one chunk holds several frames", () => {
    const progress: PipelineEvent = {
      type: "stage_progress",
      stage: "scenes",
      done: 1,
      total: 3,
    };
    const parser = new SSEFrameParser();
    const events = parser.feed(
      frame(startScenes) + frame(progress) + frame(doneScenes),
    );
    expect(events).toEqual([startScenes, progress, doneScenes]);
  });

  it("handles CRLF line terminators", () => {
    const crlf = `event: ${startScenes.type}\r\ndata: ${JSON.stringify(
      startScenes,
    )}\r\n\r\n`;
    const parser = new SSEFrameParser();
    expect(parser.feed(crlf)).toEqual([startScenes]);
  });

  it("does not emit a trailing unterminated frame", () => {
    const parser = new SSEFrameParser();
    const whole = frame(startScenes);
    // feed everything except the final blank-line terminator
    const events = parser.feed(whole.slice(0, whole.length - 1));
    expect(events).toEqual([]);
  });

  it("throws SSEProtocolError on malformed JSON in a frame", () => {
    const parser = new SSEFrameParser();
    expect(() => parser.feed("event: error\ndata: {not json}\n\n")).toThrow(
      SSEProtocolError,
    );
  });

  it("throws SSEProtocolError when a frame has an empty data value", () => {
    const parser = new SSEFrameParser();
    expect(() => parser.feed("event: error\ndata:\n\n")).toThrow(
      SSEProtocolError,
    );
  });

  it("throws SSEProtocolError when a non-empty frame has no data line", () => {
    const parser = new SSEFrameParser();
    expect(() => parser.feed("event: error\n\n")).toThrow(SSEProtocolError);
  });
});
