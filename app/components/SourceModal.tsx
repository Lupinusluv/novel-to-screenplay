/**
 * Traceability popover: pins a scene back to the source novel — the
 * anti-hallucination trust closure. It ALWAYS shows `scene.source.excerpt`
 * verbatim (so trust never depends on locating succeeding), and when the
 * excerpt can be located in the novel it renders a ±200-char context window
 * with the passage `<mark>`-highlighted and scrolled into view.
 *
 * Security (E7): the novel is user-pasted text. The highlight is built from
 * React text nodes ({before}<mark>{match}</mark>{after}) + `whitespace-pre-wrap`
 * — NEVER `dangerouslySetInnerHTML`, which would turn pasted `<script>` into a
 * DOM injection. React text nodes escape by construction.
 *
 * A11y (E8/E9): role="dialog" + aria-modal + aria-labelledby; focus moves in on
 * open, Tab is trapped, focus returns to the opener on close; Esc closes; only a
 * backdrop mousedown closes (the panel stops propagation so selecting source
 * text never dismisses the dialog).
 */

"use client";

import { useEffect, useId, useMemo, useRef } from "react";
import type { Scene } from "../../lib/schema/screenplay";
import { locateExcerpt } from "../../lib/client/locateExcerpt";

const CONTEXT_RADIUS = 200;

export function SourceModal({
  scene,
  novel,
  onClose,
}: {
  scene: Scene;
  novel: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);

  // Locating walks the whole novel on the fallback path; memoize so it doesn't
  // re-scan a large novel on every re-render (focus/scroll effects re-render).
  const match = useMemo(
    () => locateExcerpt(novel, scene.source.excerpt),
    [novel, scene.source.excerpt],
  );

  // Esc to close (E8). Listen on document so it fires regardless of focus. We do
  // NOT stopPropagation: the modal isn't the only possible Esc consumer, and
  // swallowing the event on a shared document listener would suppress other
  // (e.g. future global) Escape handlers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus in on open; restore to the opener (last focused element) on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Scroll the highlight into view once located (E20). jsdom has no layout, so
  // guard the call — tests assert the ref path, not real scroll physics.
  useEffect(() => {
    const el = markRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center" });
      } catch {
        /* jsdom: not implemented — ignore */
      }
    }
  }, [match?.start, match?.end]);

  // Keep Tab focus inside the dialog (simple focus trap).
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const before = match
    ? novel.slice(Math.max(0, match.start - CONTEXT_RADIUS), match.start)
    : "";
  const hit = match ? novel.slice(match.start, match.end) : "";
  const after = match
    ? novel.slice(match.end, match.end + CONTEXT_RADIUS)
    : "";
  const leadingEllipsis = match && match.start - CONTEXT_RADIUS > 0;
  const trailingEllipsis = match && match.end + CONTEXT_RADIUS < novel.length;

  return (
    <div
      data-testid="source-backdrop"
      onMouseDown={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
        className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-4 overflow-hidden rounded-xl bg-white p-6 shadow-xl outline-none dark:bg-zinc-900"
      >
        <header className="flex items-start justify-between gap-3">
          <h2
            id={titleId}
            className="text-lg font-semibold text-zinc-900 dark:text-zinc-100"
          >
            第 {scene.source.chapter} 章 · 溯源
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md px-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
          >
            ✕
          </button>
        </header>

        <section className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            场景摘录
          </p>
          <p className="rounded-md bg-zinc-50 p-3 text-sm leading-6 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            {scene.source.excerpt}
          </p>
        </section>

        <section className="flex min-h-0 flex-1 flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            原文定位
          </p>
          {match ? (
            <div className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 p-3 text-sm leading-6 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
              {leadingEllipsis ? "…" : ""}
              {before}
              <mark
                ref={markRef}
                className="rounded bg-amber-200 px-0.5 text-zinc-900 dark:bg-amber-400/40 dark:text-amber-100"
              >
                {hit}
              </mark>
              {after}
              {trailingEllipsis ? "…" : ""}
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-zinc-300 p-3 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              未能在原文中精确定位（可能原文已被编辑），上方为场景摘录。
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
