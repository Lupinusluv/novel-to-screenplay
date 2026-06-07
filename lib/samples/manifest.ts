/**
 * Built-in sample corpus (PR10). The single source of truth for the example
 * picker: each entry pairs display metadata (shown in the UI) with the on-disk
 * filename (server-only). The UI fetches the metadata list; it never sees or
 * sends a filename.
 *
 * Security: `id` is the only thing the client sends back. The route resolves it
 * through {@link sampleFileById}, an exact-match lookup against this fixed table,
 * so a crafted `id` can never escape `samples/` (no path is ever built from user
 * input).
 *
 * Each shipped sample is sized to yield a multi-scene screenplay and has been
 * run end-to-end through the real pipeline. Adding a genre is one row here plus
 * one file in `samples/`.
 */

/** Client-safe metadata (no filesystem paths). */
export interface SampleMeta {
  /** Stable id sent by the client (`?id=`). */
  id: string;
  /** Genre tag shown as a chip. */
  genre: string;
  /** Human title for the option. */
  title: string;
  /** One line: what this sample stresses in the pipeline. */
  blurb: string;
}

interface SampleEntry extends SampleMeta {
  /** Filename under `samples/` (server-only). */
  file: string;
}

const ENTRIES: SampleEntry[] = [
  {
    id: "honglou",
    genre: "古典章回",
    title: "《红楼梦》海棠诗社（第36–38回）",
    blurb: "群戏与诗社雅集——旁白、总结性叙述、视角切换、古汉语，加上大量人物别名，最考验跨章一致性。",
    file: "honglou-haitang.txt",
  },
  {
    id: "webnovel",
    genre: "现代网文",
    title: "人生何处不青山 · 轮回秋日的信",
    blurb: "同一部小说的两段连续章节——心理活动、世界观铺陈与长篇连续叙事的拆解。",
    file: "qingshan.txt",
  },
  {
    id: "prose",
    genre: "散文",
    title: "鲁迅《从百草园到三味书屋》",
    blurb: "缺乏明确剧情冲突与人物目标时，能否从写景与回忆中提取出可视化的场景。",
    file: "baicaoyuan.txt",
  },
  {
    id: "yishiliu",
    genre: "意识流",
    title: "《追忆似水年华》节选",
    blurb: "大量内心活动、回忆与抽象思维，如何转换为可拍摄的戏剧场景。",
    file: "zhuiyi.txt",
  },
];

/** Client-safe metadata list for the picker. */
export const SAMPLE_METAS: SampleMeta[] = ENTRIES.map(
  ({ file: _file, ...meta }) => meta,
);

/** Resolve a client-supplied id to its on-disk filename, or undefined. */
export function sampleFileById(id: string): string | undefined {
  return ENTRIES.find((e) => e.id === id)?.file;
}
