/**
 * GET /api/sample — serves the built-in sample novel to the browser (D3). The
 * `samples/` corpus lives outside `public/`, so the client cannot fetch it
 * directly; this lazy fs read keeps the sample out of the first-load bundle and
 * gives a single source of truth.
 *
 * Hardening (E12): resolve via `process.cwd()` (never a relative path), declare
 * the Node runtime (fs) + request-time `dynamic`, set an explicit utf-8
 * `Content-Type`, and surface a read failure as 500 with a body rather than
 * silently breaking the demo's first screen.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAMPLE_PATH = path.join(
  process.cwd(),
  "samples",
  "honglou-meng-ch1-3.txt",
);

export async function GET(): Promise<Response> {
  try {
    const text = await readFile(SAMPLE_PATH, "utf-8");
    return new Response(text, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    return Response.json(
      { error: `无法读取内置示例：${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
