/**
 * Minimal glob matcher for manifest blackboard permission patterns.
 *
 * Supports `**` (any number of path segments), `*` (within one segment),
 * `?` (single char) and exact paths. No external dependency.
 */

function matchSegments(pattern: string[], segs: string[]): boolean {
  // Classic recursive matcher with `**` backtracking.
  const p = pattern[0];
  if (pattern.length === 0) return segs.length === 0;
  if (segs.length === 0) return pattern.length === 1 && p === "**";

  if (p === "**") {
    // `**` may consume zero or more segments.
    if (matchSegments(pattern.slice(1), segs)) return true;
    return matchSegments(pattern, segs.slice(1));
  }
  return matchSegment(p, segs[0]) && matchSegments(pattern.slice(1), segs.slice(1));
}

function matchSegment(pattern: string, s: string): boolean {
  // Single-segment glob with * and ?; recursive over pattern chars.
  function rec(pi: number, si: number): boolean {
    if (pi === pattern.length) return si === s.length;
    const c = pattern[pi];
    if (c === "*") {
      for (let k = si; k <= s.length; k++) {
        if (rec(pi + 1, k)) return true;
      }
      return false;
    }
    if (c === "?") return si < s.length && rec(pi + 1, si + 1);
    return si < s.length && pattern[pi] === s[si] && rec(pi + 1, si + 1);
  }
  return rec(0, 0);
}

/** Match a workspace-relative path against a manifest glob pattern. */
export function matchGlob(pattern: string, relPath: string): boolean {
  const norm = (v: string) =>
    v
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
  const p = norm(pattern);
  const target = norm(relPath);
  if (p === "**" || p === "**/*") return true;
  return matchSegments(p.split("/"), target.split("/"));
}

/** True when relPath matches at least one pattern in the list. */
export function matchAnyGlob(patterns: readonly string[], relPath: string): boolean {
  return patterns.some((p) => matchGlob(p, relPath));
}
