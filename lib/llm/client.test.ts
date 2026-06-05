import { describe, it, expect, vi } from "vitest";
import {
  extractJSON,
  createLLMClient,
  loadLLMConfigFromEnv,
  type LLMConfig,
} from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatBody(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

const baseConfig = (over: Partial<LLMConfig> = {}): LLMConfig => ({
  baseUrl: "https://api.example.com/v1",
  apiKey: "test-key",
  model: "test-model",
  retryBaseDelayMs: 0,
  ...over,
});

describe("extractJSON", () => {
  it("parses raw JSON object", () => {
    expect(extractJSON('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("parses JSON wrapped in a ```json fenced block", () => {
    const text = "好的，结果如下：\n```json\n{\"name\":\"林深\"}\n```\n完成。";
    expect(extractJSON(text)).toEqual({ name: "林深" });
  });

  it("parses JSON wrapped in a bare ``` fenced block", () => {
    const text = "```\n[1, 2, 3]\n```";
    expect(extractJSON(text)).toEqual([1, 2, 3]);
  });

  it("extracts a JSON object embedded in surrounding prose", () => {
    const text = '注意：这是结果 {"ok": true, "items": [1,2]} —— 以上。';
    expect(extractJSON(text)).toEqual({ ok: true, items: [1, 2] });
  });

  it("throws when no JSON can be found", () => {
    expect(() => extractJSON("没有任何 JSON 内容")).toThrow();
  });
});

describe("createLLMClient.chat", () => {
  it("POSTs to the chat/completions endpoint with auth and returns the content", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(chatBody("你好")));
    const client = createLLMClient(baseConfig({ fetchImpl }));

    const out = await client.chat([{ role: "user", content: "hi" }]);

    expect(out).toBe("你好");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("retries on a 500 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500))
      .mockResolvedValueOnce(jsonResponse(chatBody("ok")));
    const client = createLLMClient(baseConfig({ fetchImpl, maxRetries: 2 }));

    const out = await client.chat([{ role: "user", content: "hi" }]);

    expect(out).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and throws", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    const client = createLLMClient(baseConfig({ fetchImpl, maxRetries: 2 }));

    await expect(
      client.chat([{ role: "user", content: "hi" }]),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});

describe("createLLMClient.chatJSON", () => {
  it("returns parsed JSON from a fenced response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(chatBody('```json\n{"character_id":"char_lin"}\n```')),
    );
    const client = createLLMClient(baseConfig({ fetchImpl }));

    const out = await client.chatJSON<{ character_id: string }>([
      { role: "user", content: "extract" },
    ]);

    expect(out).toEqual({ character_id: "char_lin" });
  });
});

describe("loadLLMConfigFromEnv", () => {
  it("reads base url, key and model from env", () => {
    const cfg = loadLLMConfigFromEnv({
      LLM_BASE_URL: "https://api.deepseek.com/v1",
      LLM_API_KEY: "sk-123",
      LLM_MODEL: "deepseek-chat",
    });
    expect(cfg.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(cfg.apiKey).toBe("sk-123");
    expect(cfg.model).toBe("deepseek-chat");
  });

  it("throws a helpful error when required vars are missing", () => {
    expect(() => loadLLMConfigFromEnv({})).toThrow(/LLM_API_KEY/);
  });
});
