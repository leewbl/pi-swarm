/**
 * YAML front matter + Markdown body document format, shared by tasks,
 * blackboard documents and claim-adjacent markdown files.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FM_SEPARATOR = "---";

export interface ParsedDocument {
  data: unknown;
  body: string;
}

/** Returns null when the document has no valid front matter block. */
export function parseDocument(raw: string): ParsedDocument | null {
  const trimmed = raw.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith(`${FM_SEPARATOR}\n`)) return null;
  const end = trimmed.indexOf(`\n${FM_SEPARATOR}`, FM_SEPARATOR.length);
  if (end === -1) return null;

  const frontRaw = trimmed.slice(FM_SEPARATOR.length + 1, end);
  const afterEnd = trimmed.slice(end + 1 + FM_SEPARATOR.length);
  const body = afterEnd.startsWith("\n") ? afterEnd.slice(1) : afterEnd;

  try {
    return { data: parseYaml(frontRaw), body };
  } catch {
    return null;
  }
}

export function serializeDocument(front: unknown, body: string): string {
  const fm = stringifyYaml(front, { lineWidth: 120 }).trimEnd();
  return `${FM_SEPARATOR}\n${fm}\n${FM_SEPARATOR}\n\n${body.trimEnd()}\n`;
}
