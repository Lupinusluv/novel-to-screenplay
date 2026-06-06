/**
 * SSE encoder (E9). Pure function: a `PipelineEvent` → one Server-Sent-Events
 * frame using the *typed* event channel (`event: <type>`) plus a single JSON
 * `data:` line. Keeping it pure + transport-free makes both the encoding and the
 * orchestrator independently unit-testable; the route only glues them together.
 */

import type { PipelineEvent } from "./events";

/** Encode one event as an SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function eventToSSE(event: PipelineEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
