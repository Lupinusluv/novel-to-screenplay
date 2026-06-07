import { describe, it, expect } from "vitest";
import { GET } from "./route";
import { SAMPLE_METAS } from "../../../lib/samples/manifest";

function req(url: string): Request {
  return new Request(url);
}

describe("GET /api/sample", () => {
  it("returns the sample manifest as JSON when no id is given", async () => {
    const res = await GET(req("http://localhost/api/sample"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { samples: typeof SAMPLE_METAS };
    expect(body.samples.length).toBe(SAMPLE_METAS.length);
    expect(body.samples.map((s) => s.id)).toContain("honglou");
    // metadata only — never leak filesystem paths
    for (const s of body.samples) {
      expect(s).not.toHaveProperty("file");
      expect(s.genre.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(0);
    }
  });

  it("returns a known sample as utf-8 text/plain", async () => {
    const res = await GET(req("http://localhost/api/sample?id=honglou"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await res.text();
    expect(text.length).toBeGreaterThan(100);
  });

  it("serves every sample declared in the manifest", async () => {
    for (const meta of SAMPLE_METAS) {
      const res = await GET(req(`http://localhost/api/sample?id=${meta.id}`));
      expect(res.status, `sample ${meta.id} should resolve`).toBe(200);
      const text = await res.text();
      expect(text.length, `sample ${meta.id} should be non-trivial`).toBeGreaterThan(100);
    }
  });

  it("404s an unknown id without touching the filesystem", async () => {
    const res = await GET(req("http://localhost/api/sample?id=../../etc/passwd"));
    expect(res.status).toBe(404);
  });
});
