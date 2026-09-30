import { load } from "cheerio";
import { hostUrl } from "./urls.ts";

/** Resolve one exact-host HTTPS base without changing the physical document identity. */
export function htmlBaseUrl(html: string, hostname: string, source: string, allow = false): string {
  const $ = load(html);
  const bases = $("base[href]");
  if (!bases.length) return hostUrl(source, hostname);
  if (!allow || bases.length !== 1) throw new Error("HTML base URL requires an explicit extraction policy");
  return hostUrl(bases.attr("href")!, hostname, source);
}
