import { InvalidValueError, MissingKeyError } from "../core/http.ts";

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
