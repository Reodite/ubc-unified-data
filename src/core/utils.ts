export function utcnow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Byte-order comparison: codepoint order, not collation. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
