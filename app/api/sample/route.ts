/**
 * GET /api/sample — serves the built-in sample corpus to the browser (D3, PR10).
 *
 *  - `GET /api/sample`            → JSON `{ samples: SampleMeta[] }` for the picker.
 *  - `GET /api/sample?id=<id>`    → the sample novel as utf-8 text/plain.
 *
 * The `samples/` corpus lives outside `public/`, so the client cannot fetch it
 * directly; this lazy fs read keeps the corpus out of the first-load bundle and
 * gives a single source of truth.
 *
 * Hardening (E12): resolve via `process.cwd()` (never a relative path), declare
 * the Node runtime (fs) + request-time `dynamic`, set an explicit utf-8
 * `Content-Type`. The `id` is resolved through the fixed allowlist in
 * `manifest.ts` (never concatenated into a path), so there is no path-traversal
 * surface; an unknown id is a 404 and a read failure is a 500 with a body.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLE_METAS, sampleFileById } from "../../../lib/samples/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");

  // No id → the picker manifest.
  if (!id) {
    return Response.json({ samples: SAMPLE_METAS });
  }

  const file = sampleFileById(id);
  if (!file) {
    return Response.json({ error: `未知示例：${id}` }, { status: 404 });
  }

  try {
    const text = await readFile(
      path.join(process.cwd(), "samples", file),
      "utf-8",
    );
    return new Response(text, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    return Response.json(
      {
        error: `无法读取内置示例：${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}
