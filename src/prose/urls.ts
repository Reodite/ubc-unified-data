/** Repair unambiguous email/bare-host href spellings without guessing arbitrary relative paths. */
export function normalizedHref(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed)) return `mailto:${trimmed}`;
  if (/^(?:www\.[a-z0-9.-]+|(?:[a-z0-9-]+\.)*ubc\.ca)(?::\d+)?(?:[/?#]|$)/i.test(trimmed)) return `https://${trimmed}`;
  return value;
}

/** Prefer the secure transport for official links while keeping their host, path and query. */
export function secureUbcLink(value: string, base?: string): string {
  const url = new URL(value, base);
  if (url.protocol === "http:" && (url.hostname === "ubc.ca" || url.hostname.endsWith(".ubc.ca")))
    url.protocol = "https:";
  return url.href;
}
