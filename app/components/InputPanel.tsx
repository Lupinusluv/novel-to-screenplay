/**
 * Input surface: paste into a textarea, upload a `.txt` (read client-side with
 * FileReader), or load the built-in sample via `GET /api/sample` (D3). The
 * controlled `value` lives in `ConverterApp`. 转换 is disabled while empty, over
 * the character limit, or busy.
 */

"use client";

import { useRef, useState } from "react";

/** Mirrors `MAX_NOVEL_CHARS` in lib/agent/orchestrator.ts (the route 413s past
 *  this). Duplicated rather than imported to keep agent runtime out of the
 *  client bundle (E10). */
export const MAX_NOVEL_CHARS = 200000;

export function InputPanel({
  value,
  onChange,
  onConvert,
  busy = false,
  fetchImpl = fetch,
}: {
  value: string;
  onChange: (text: string) => void;
  onConvert: () => void;
  busy?: boolean;
  fetchImpl?: typeof fetch;
}) {
  const [loadingSample, setLoadingSample] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const count = value.length;
  const overLimit = count > MAX_NOVEL_CHARS;
  const canConvert = value.trim().length > 0 && !overLimit && !busy;

  async function loadSample() {
    setLoadingSample(true);
    setSampleError(null);
    try {
      const res = await fetchImpl("/api/sample");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onChange(await res.text());
    } catch (err) {
      setSampleError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSample(false);
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  return (
    <div className="flex flex-col gap-3">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="粘贴小说正文（≥3 章效果最佳），或上传 .txt / 载入内置示例…"
        className="h-64 w-full resize-y rounded-lg border border-zinc-300 bg-white p-3 font-mono text-sm leading-6 text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className={overLimit ? "text-red-600" : undefined}>
          {count.toLocaleString()} / {MAX_NOVEL_CHARS.toLocaleString()} 字
        </span>
        {sampleError && (
          <span className="text-red-600">示例载入失败：{sampleError}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onConvert}
          disabled={!canConvert}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:disabled:bg-zinc-700"
        >
          转换
        </button>

        <button
          type="button"
          onClick={loadSample}
          disabled={loadingSample || busy}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {loadingSample ? "载入中…" : "用内置示例"}
        </button>

        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          上传 .txt
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,text/plain"
          onChange={handleFile}
          className="hidden"
        />
      </div>
    </div>
  );
}
