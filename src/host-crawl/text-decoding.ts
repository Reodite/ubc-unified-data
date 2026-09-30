const httpCharset = /charset\s*=\s*["']?([^;\s"']+)/i;
const tagPattern = /^<[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/;
const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function headCharset(bytes: Uint8Array): string | undefined {
  const prefix = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  let inHead = false;
  const skipped: string[] = [];
  for (let offset = 0; offset < prefix.length;) {
    const start = prefix.indexOf("<", offset);
    if (start < 0) break;
    if (prefix.startsWith("<!--", start)) {
      const end = prefix.indexOf("-->", start + 4);
      if (end < 0) break;
      offset = end + 3;
      continue;
    }
    const tag = tagPattern.exec(prefix.slice(start))?.[0];
    if (!tag) break;
    offset = start + tag.length;
    if (/^<!|^<\?/.test(tag)) continue;
    const name = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(tag);
    if (!name) continue;
    const closing = Boolean(name[1]);
    const element = name[2]!.toLowerCase();
    if (skipped.length) {
      if (closing && element === skipped.at(-1)) skipped.pop();
      else if (!closing && element === "template" && skipped.at(-1) === "template") skipped.push(element);
      continue;
    }
    if (element === "body" || (closing && element === "head")) break;
    if (element === "head" && !closing) {
      inHead = true;
      continue;
    }
    if (!inHead) {
      if (!closing && element !== "html") break;
      continue;
    }
    if (closing) continue;
    if (["script", "style", "template", "noscript", "title"].includes(element)) {
      skipped.push(element);
      continue;
    }
    if (!["meta", "base", "link"].includes(element)) break;
    if (element !== "meta") continue;
    const attributes = new Map<string, string>();
    for (const attribute of tag.slice(name[0].length, -1).matchAll(attributePattern)) {
      const key = attribute[1]!.toLowerCase();
      if (attributes.has(key)) continue;
      attributes.set(key, attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    if (attributes.get("http-equiv")?.trim().toLowerCase() !== "content-type") continue;
    const label = httpCharset.exec(attributes.get("content") ?? "")?.[1]?.toLowerCase();
    if (label === "windows-1252" || label === "iso-8859-1") return label;
  }
  return undefined;
}

export function decodeRecordedText(bytes: Uint8Array, contentType: string): string {
  // Empty responses bypass decoding even when the declared charset is unsupported.
  if (!bytes.length) return "";
  const declared = httpCharset.exec(contentType)?.[1];
  const html = contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/html";
  const charset = declared ?? (html ? headCharset(bytes) : undefined) ?? "utf-8";
  return new TextDecoder(charset, { fatal: true }).decode(bytes);
}
