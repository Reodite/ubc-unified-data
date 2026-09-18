import { publicUbcUrl } from "../prose/client.ts";

export function normalizeHost(value: string): string {
  if (typeof value !== "string" || !value || /[\s/@:#?\\]/.test(value)) throw new Error("Invalid hostname");
  const host = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "ubc.ca" && !host.endsWith(".ubc.ca")) throw new Error("Not an official UBC hostname");
  if (
    !/^[a-z0-9.-]+$/.test(host) ||
    host.split(".").some((part) => !part || part.startsWith("-") || part.endsWith("-"))
  )
    throw new Error("Invalid hostname");
  return host;
}

export function hostUrl(value: string, hostname: string, base = `https://${hostname}/`): string {
  const url = new URL(value, base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    normalizeHost(url.hostname) !== normalizeHost(hostname)
  )
    throw new Error("URL is outside the exact HTTPS host scope");
  url.hostname = normalizeHost(url.hostname);
  url.hash = "";
  return url.href;
}

export const UNSUPPORTED_DOCUMENT = "Document format requires a reviewed text-extraction adapter";

/** Allow declared PDF documents without widening authentication, query, or other resource boundaries. */
export function documentPageExclusion(value: string, hostname: string, formats: readonly "pdf"[]): string | null {
  const exclusion = pageExclusion(value, hostname);
  let url: URL;
  try {
    url = new URL(publicUbcUrl(hostUrl(value, hostname)));
  } catch {
    return "Different or unsafe public destination";
  }
  if (exclusion !== UNSUPPORTED_DOCUMENT) return exclusion;
  const path = decodeURIComponent(url.pathname);
  if (!formats.includes("pdf") || !/\.pdf$/i.test(path) || url.search) return exclusion;
  url.pathname = path.slice(0, -4);
  if (url.pathname.startsWith("/wp-content/uploads/")) url.pathname = url.pathname.slice("/wp-content/uploads".length);
  return pageExclusion(url.href, hostname);
}

export function pageExclusion(value: string, hostname: string): string | null {
  let url: URL;
  try {
    url = new URL(hostUrl(value, hostname));
  } catch {
    return "Different or unsafe host destination";
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return "Ambiguous encoded route";
  }
  if (/%|\\/.test(pathname)) return "Ambiguous encoded route";
  if (/\/{2,}/.test(pathname)) return "Ambiguous repeated path separator";
  if (
    /\.(?:pdf|docx?|odt|rtf|xlsx?|pptx?|csv|md)(?:$|\/)/i.test(pathname) ||
    (/\.txt(?:$|\/)/i.test(pathname) && pathname !== "/robots.txt")
  )
    return UNSUPPORTED_DOCUMENT;
  if (/\/(?:wp-admin|wp-login\.php|xmlrpc\.php|wp-comments-post\.php|wp-json)(?:\/|$)/i.test(pathname))
    return "Administration, form action or machine endpoint";
  if (/\/(?:wp-content|wp-includes|feed)(?:\/|$)/i.test(pathname)) return "Theme, script or feed resource";
  if (
    /\.(?:css|[cm]?js|map|wasm|zip|gz|png|jpe?g|gif|webp|avif|tiff?|bmp|svg|ico|mp[34]|mov|avi|webm|wav|ogg|aac|flac|ics|xml|json|txt|woff2?|ttf|otf|eot)(?:$|\/)/i.test(
      pathname,
    )
  )
    return "Static asset or machine-readable resource";
  if (
    [...url.searchParams].some(
      ([key, value]) => !["p", "page_id", "page", "paged"].includes(key) || !/^\d+$/.test(value),
    )
  )
    return "Unsupported query or form selection";
  return null;
}
