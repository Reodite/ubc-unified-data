import { SaxesParser } from "saxes";

export function parseSitemap(body: string): { kind: "index" | "pages"; locations: string[] } {
  const parser = new SaxesParser({ xmlns: true });
  const stack: Array<{ local: string; uri: string }> = [];
  const locations: string[] = [];
  let kind: "index" | "pages" | undefined;
  let namespace = "";
  let location = "";
  let count = 0;
  parser.on("doctype", () => {
    throw new Error("Sitemap document types are not supported");
  });
  parser.on("opentag", (tag) => {
    if (stack.length === 0) {
      if (
        !["urlset", "sitemapindex"].includes(tag.local) ||
        !["", "http://www.sitemaps.org/schemas/sitemap/0.9"].includes(tag.uri)
      )
        throw new Error("Invalid sitemap document root");
      kind = tag.local === "urlset" ? "pages" : "index";
      namespace = tag.uri;
    } else if (stack.length === 1) {
      if (tag.local !== (kind === "pages" ? "url" : "sitemap") || tag.uri !== namespace)
        throw new Error("Unexpected sitemap entry");
      location = "";
      count = 0;
    } else if (stack.length === 2 && tag.local === "loc" && tag.uri === namespace) {
      count++;
    } else if (stack.length >= 3 && stack[2]!.local === "loc" && stack[2]!.uri === namespace) {
      throw new Error("Sitemap location contains nested markup");
    }
    stack.push({ local: tag.local, uri: tag.uri });
  });
  const text = (value: string) => {
    if (stack.length === 3 && stack[2]!.local === "loc" && stack[2]!.uri === namespace) location += value;
    else if (stack.length <= 2 && value.trim()) throw new Error("Unexpected sitemap text");
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    if (stack.length === 2) {
      if (count !== 1 || !location.trim()) throw new Error("Malformed sitemap location");
      locations.push(location.trim());
    }
    stack.pop();
  });
  parser.write(body).close();
  if (!kind) throw new Error("Missing sitemap document root");
  return { kind, locations };
}
