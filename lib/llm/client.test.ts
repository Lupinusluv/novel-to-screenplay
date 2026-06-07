import { describe, it, expect, vi } from "vitest";
import {
  extractJSON,
  createLLMClient,
  loadLLMConfigFromEnv,
  LLMError,
  classifyLLMErrorCode,
  llmErrorCode,
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

describe("classifyLLMErrorCode (402 → insufficient_balance)", () => {
  it("classifies any 402 as insufficient_balance (demo-friendly, status preserved separately)", () => {
    expect(classifyLLMErrorCode(402, "")).toBe("insufficient_balance");
  });

  it("classifies a non-402 body that mentions Insufficient Balance (provider quirk fallback)", () => {
    const body = '{"error":{"message":"Insufficient Balance","type":"x"}}';
    expect(classifyLLMErrorCode(400, body)).toBe("insufficient_balance");
  });

  it("matches the Chinese 余额不足 phrasing too", () => {
    expect(classifyLLMErrorCode(403, "账户余额不足，请充值")).toBe(
      "insufficient_balance",
    );
  });

  it("returns undefined for an ordinary auth failure", () => {
    expect(classifyLLMErrorCode(401, '{"error":"unauthorized"}')).toBeUndefined();
  });
});

describe("createLLMClient.chat — structured 402 error", () => {
  it("throws an LLMError carrying status 402 + code insufficient_balance", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "Insufficient Balance" } }, 402),
    );
    const client = createLLMClient(baseConfig({ fetchImpl }));

    const err = await client
      .chat([{ role: "user", content: "hi" }])
      .catch((e) => e);

    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).status).toBe(402);
    expect((err as LLMError).code).toBe("insufficient_balance");
    expect(llmErrorCode(err)).toBe("insufficient_balance");
  });

  it("does NOT retry a 402 (it is not transient — fetch called exactly once)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "Insufficient Balance" } }, 402),
    );
    const client = createLLMClient(baseConfig({ fetchImpl, maxRetries: 2 }));

    await client.chat([{ role: "user", content: "hi" }]).catch(() => {});

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a 401 throws an LLMError with no insufficient_balance code", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "nope" }, 401));
    const client = createLLMClient(baseConfig({ fetchImpl }));

    const err = await client
      .chat([{ role: "user", content: "hi" }])
      .catch((e) => e);

    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).status).toBe(401);
    expect((err as LLMError).code).toBeUndefined();
    expect(llmErrorCode(err)).toBeUndefined();
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

  it("falls back to DeepSeek when no LLM_* are set but DEEPSEEK_API_KEY is", () => {
    const cfg = loadLLMConfigFromEnv({ DEEPSEEK_API_KEY: "sk-deep" });
    expect(cfg.baseUrl).toBe("https://api.deepseek.com");
    expect(cfg.model).toBe("deepseek-chat");
    expect(cfg.apiKey).toBe("sk-deep");
  });

  it("prefers explicit LLM_* over the DeepSeek fallback", () => {
    const cfg = loadLLMConfigFromEnv({
      LLM_BASE_URL: "https://example.com/v1",
      LLM_API_KEY: "sk-explicit",
      LLM_MODEL: "gpt-x",
      DEEPSEEK_API_KEY: "sk-deep",
    });
    expect(cfg.baseUrl).toBe("https://example.com/v1");
    expect(cfg.apiKey).toBe("sk-explicit");
    expect(cfg.model).toBe("gpt-x");
  });

  it("errors on partial LLM_* even with a DeepSeek key (no silent fallback) (I8)", () => {
    expect(() =>
      loadLLMConfigFromEnv({
        LLM_BASE_URL: "https://example.com/v1",
        DEEPSEEK_API_KEY: "sk-deep",
      }),
    ).toThrow(/LLM_API_KEY/);
  });
});
