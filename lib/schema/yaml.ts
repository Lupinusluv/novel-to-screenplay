/**
 * Screenplay <-> YAML serialization.
 *
 * YAML (not JSON) is the on-disk/on-screen format because it is the one the
 * author edits by hand: block style, comments-friendly, diff-friendly.
 * `fromYAML` always routes the parsed data through the zod schema, so a
 * hand-edited file that drifts from the contract fails loudly rather than
 * silently producing a malformed screenplay.
 */

import { parse, stringify } from "yaml";
import { parseScreenplay, type Screenplay } from "./screenplay";

/** Serialize a screenplay to human-editable block YAML. */
export function toYAML(screenplay: Screenplay): string {
  return stringify(screenplay, {
    // Never emit `&anchor`/`*alias` for repeated nodes — they are correct
    // YAML but hostile to a human editor reading the screenplay.
    aliasDuplicateObjects: false,
    // Keep block style; only fall back to flow for very deep nesting.
    blockQuote: "literal",
  });
}

/**
 * Parse YAML and validate it against the screenplay schema.
 * Throws on malformed YAML (from the parser) or on schema violations
 * (ZodError) — never returns an unvalidated object.
 */
export function fromYAML(text: string): Screenplay {
  const data = parse(text);
  return parseScreenplay(data);
}
