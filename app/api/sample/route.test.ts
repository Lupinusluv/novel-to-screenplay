import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/sample", () => {
  it("returns the built-in sample novel as utf-8 text/plain", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    const text = await res.text();
    expect(text.length).toBeGreaterThan(100);
  });
});
