import { collectNumberedPages } from "../scraping/pagination.ts";
import { InvalidValueError, MissingKeyError, type Http, type Params } from "./http.ts";

/** Read one `var <name> = [...]/{...}` literal out of a page. */
export function jsLiteral(html: string, name: string): unknown {
  const pattern = new RegExp(`\\bvar\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*`);
  const match = pattern.exec(html);
  if (!match) throw new MissingKeyError(name);

  let start = match.index + match[0].length;
  while (start < html.length && /\s/.test(html[start]!)) start += 1;
  const opener = html[start]!;
  const closer: string | undefined = { "[": "]", "{": "}" }[opener];
  if (!closer) throw new InvalidValueError(`${name} is not an array or object literal`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = "";

  for (let index = start; index < html.length; index += 1) {
    const char = html[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
    } else if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(html.slice(start, index + 1));
      }
    }
  }
  throw new InvalidValueError(`unterminated literal for ${name}`);
}

/** Fetch every page of a WP REST collection using X-WP-TotalPages. */
export async function wpCollection(
  http: Http,
  host: string,
  pathName: string,
  opts: { params?: Params; perPage?: number; workers?: number } = {},
): Promise<unknown[]> {
  const url = `https://${host}/wp-json/${pathName}`;
  const base: Params = { ...(opts.params ?? {}), per_page: opts.perPage ?? 100 };

  const first = await http.get(url, { params: { ...base, page: 1 } });
  const records = (await first.json()) as unknown[];
  const pages = Number(first.headers.get("X-WP-TotalPages") || 1);

  if (pages > 1) {
    return collectNumberedPages(
      http,
      records,
      pages,
      async (page) => (await http.getJson(url, { params: { ...base, page } })) as unknown[],
      opts.workers,
    );
  }
  return records;
}
