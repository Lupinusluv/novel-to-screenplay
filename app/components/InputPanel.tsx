/**
 * Input surface (PR10): paste into a textarea, upload one or more `.txt` files
 * (read client-side, natural-sorted by filename, concatenated), or pick from a
 * gallery of built-in samples spanning several genres.
 *
 * The sample gallery is driven by `GET /api/sample` (the manifest); clicking a
 * card loads its text via `GET /api/sample?id=<id>`. The controlled `value`
 * lives in `ConverterApp`. 转换 is disabled while empty, over the character
 * limit, or busy.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { concatNovelFiles } from "../../lib/client/concatFiles";
import type { SampleMeta } from "../../lib/samples/manifest";

/** Mirrors `MAX_NOVEL_CHARS` in lib/agent/orchestrator.ts (the route 413s past
 *  this). Duplicated rather than imported to keep agent runtime out of the
 *  client bundle (E10). */
export const MAX_NOVEL_CHARS = 200000;

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
    reader.readAsText(file);
  });
}

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
  const [samples, setSamples] = useState<SampleMeta[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const count = value.length;
  const overLimit = count > MAX_NOVEL_CHARS;
  const canConvert = value.trim().length > 0 && !overLimit && !busy;

  // Load the sample manifest once on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetchImpl("/api/sample");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { samples: SampleMeta[] };
        if (alive) setSamples(body.samples ?? []);
      } catch {
        // The picker is a convenience; a manifest failure shouldn't break input.
        if (alive) setSamples([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fetchImpl]);

  async function loadSample(id: string) {
    setLoadingId(id);
    setSampleError(null);
    try {
      const res = await fetchImpl(`/api/sample?id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onChange(await res.text());
    } catch (err) {
      setSampleError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingId(null);
    }
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    if (list.length === 0) return;
    setFileError(null);
    try {
      const named = await Promise.all(
        list.map(async (f) => ({ name: f.name, text: await readFileText(f) })),
      );
      onChange(concatNovelFiles(named));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    } finally {
      // Reset so re-selecting the same files fires onChange again.
      e.target.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Sample gallery */}
      {samples.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            内置示例 · 多体裁
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {samples.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => loadSample(s.id)}
                disabled={busy || loadingId !== null}
                className="group flex flex-col gap-1.5 rounded-xl border border-zinc-200 bg-white p-3 text-left transition-all hover:border-indigo-400 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-500"
              >
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
                    {s.genre}
                  </span>
                  {loadingId === s.id && (
                    <span className="text-[11px] text-zinc-400">载入中…</span>
                  )}
                </div>
                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {s.title}
                </span>
                <span className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                  {s.blurb}
                </span>
              </button>
            ))}
          </div>
          {sampleError && (
            <span className="text-xs text-red-600">
              示例载入失败：{sampleError}
            </span>
          )}
        </div>
      )}

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="粘贴小说正文（≥3 章效果最佳），或上传 .txt / 选一个上面的示例…"
        className="h-56 w-full resize-y rounded-xl border border-zinc-300 bg-white p-3.5 font-mono text-sm leading-6 text-zinc-900 shadow-inner outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className={overLimit ? "font-medium text-red-600" : undefined}>
          {count.toLocaleString()} / {MAX_NOVEL_CHARS.toLocaleString()} 字
        </span>
        {fileError && (
          <span className="text-red-600">文件读取失败：{fileError}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onConvert}
          disabled={!canConvert}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:shadow-none dark:disabled:bg-zinc-700"
        >
          {busy ? "转换中…" : "转换"}
        </button>

        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          上传 .txt（可多选）
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,text/plain"
          multiple
          onChange={handleFiles}
          className="hidden"
        />
      </div>
    </div>
  );
}
