/**
 * Injectable clock seam. Tests pass their own deterministic `now` into
 * services/event builders; production code defaults to this.
 * All persisted timestamps are ISO-8601 UTC with Z suffix (schema-enforced).
 */
export function nowIso(): string {
  return new Date().toISOString();
}
