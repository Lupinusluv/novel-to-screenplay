/**
 * SSE route: POST /api/convert. Streams the novel→screenplay pipeline's progress
 * as Server-Sent Events.
 *
 * Deliberately thin (review delta E8): all logic lives in the unit-tested
 * orchestrator + `pipelineToSSEStream`; this file only parses the request, builds
 * the LLM client from env, and returns the SSE Response with the right headers.
 * `runtime = "nodejs"` so the LLM client's fetch + env access work; `dynamic =
 * "force-dynamic"` keeps the handler request-time (never prerendered/cached).
 *
 * Request body: { "novel": "<full text>", "options"?: OrchestratorOptions }.
 * The Web Request's `signal` is forwarded so a client disconnect cancels work.
 */

import {
  pipelineToSSEStream,
  MAX_NOVEL_CHARS,
  type OrchestratorOptions,
} from "../../../lib/agent/orchestrator";
import { createLLMClient, loadLLMConfigFromEnv } from "../../../lib/llm/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function POST(req: Request): Promise<Response> {
  let body: { novel?: unknown; options?: OrchestratorOptions };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON: { novel, options? }" }, { status: 400 });
  }

  const novel = body?.novel;
  if (typeof novel !== "string" || novel.trim().length === 0) {
    return Response.json({ error: "`novel` (non-empty string) is required" }, { status: 400 });
  }
  // Review #2: reject pathological input at the HTTP layer (runPipeline also
  // guards, defense-in-depth) so a huge body never fans out into the pipeline.
  if (novel.length > MAX_NOVEL_CHARS) {
    return Response.json(
      { error: `novel too large: ${novel.length} > ${MAX_NOVEL_CHARS} chars` },
      { status: 413 },
    );
  }

  // Build the LLM client up front so a misconfigured env returns a clean 500
  // rather than a half-open stream.
  let llm: ReturnType<typeof createLLMClient>;
  try {
    llm = createLLMClient(loadLLMConfigFromEnv());
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }

  const stream = pipelineToSSEStream(novel, llm, {
    ...body.options,
    signal: req.signal,
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
