import { compareStrings } from "../base.ts";
import { plainText } from "../source-documents.ts";
import { fetchDisposition, ProseFetchError, type ProseClient } from "./client.ts";
import { discoverDrupal, discoverSitemaps, discoverWordpress } from "./discovery.ts";
import { articleLinks, extractArticle, needsRenderedHtml, NonArticleError } from "./html.ts";
import {
  makeArticle,
  mergeDiscovery,
  urlKey,
  type ArticleInput,
  type CollectionResult,
  type DiscoveryEntry,
  type InventoryEntry,
  type ProseSource,
} from "./model.ts";

export async function collectLiveSource(
  source: ProseSource,
  client: ProseClient,
  progress: (message: string) => void = () => {},
): Promise<CollectionResult> {
  const result: CollectionResult = {
    source: source.key,
    articles: [],
    inventory: [],
    discoveryErrors: [],
    discoveryNotes: [],
  };
  const discovered: DiscoveryEntry[] = [];
  const strategies =
    source.strategy === "wordpress"
      ? [discoverWordpress, discoverSitemaps]
      : source.strategy === "drupal"
        ? [discoverDrupal, discoverSitemaps]
        : [discoverSitemaps];
  for (const discover of strategies) {
    try {
      const found = await discover(source, client);
      discovered.push(...found.entries);
      result.discoveryErrors.push(...found.errors);
      result.discoveryNotes.push(...found.notes, ...found.inventories.map((url) => `Inventory: ${url}`));
    } catch (error) {
      result.discoveryErrors.push(String(error));
    }
  }
  discovered.push(
    ...(source.roots ?? []).map((url) => ({ url, discoveredBy: ["Declared public source root"], modified: null })),
  );
  const queue = mergeDiscovery(discovered);
  const queued = new Set(queue.map((entry) => urlKey(entry.url)));
  const byUrl = new Map<string, string>();
  const byId = new Map<string, string>();
  progress(`${source.key}: ${queue.length} inventory URLs before scope filtering`);
  let done = 0;
  while (queue.length) {
    const entry = queue.shift()!;
    const inventory: InventoryEntry = {
      url: entry.url,
      discovered_by: entry.discoveredBy,
      source_modified_at: entry.modified,
      status: "failed",
      reason: null,
      article_id: null,
    };
    result.inventory.push(inventory);
    const excluded =
      new URL(entry.url).hostname !== source.host
        ? "Different source host; not traversed from this inventory."
        : source.scope(entry.url, plainText(entry.title ?? ""), entry.recordType);
    if (excluded || entry.protected) {
      inventory.status = "excluded";
      inventory.reason = excluded ?? "Source API marks the record protected or not published.";
      continue;
    }
    try {
      let input: ArticleInput;
      let linkHtml: string;
      if (entry.html !== undefined && entry.title && entry.retrievedAt && !needsRenderedHtml(entry.html)) {
        input = {
          url: entry.url,
          title: entry.title,
          html: entry.html,
          upstreamId: entry.upstreamId,
          apiUrl: entry.apiUrl,
          sourceModifiedAt: entry.modified,
          retrievedAt: entry.retrievedAt,
        };
        linkHtml = entry.html;
      } else {
        const response = await client.get(entry.url);
        const redirectedScope = source.scope(response.url, plainText(entry.title ?? ""), entry.recordType);
        if (redirectedScope) {
          inventory.status = "excluded";
          inventory.reason = redirectedScope;
          inventory.resolved_url = response.url;
          continue;
        }
        input = extractArticle(response, source);
        input.upstreamId = entry.upstreamId ?? input.upstreamId;
        input.apiUrl = entry.apiUrl ?? null;
        input.sourceModifiedAt ??= entry.modified;
        linkHtml = response.body;
      }
      inventory.resolved_url = input.url;
      for (const url of articleLinks(linkHtml, source, input.url)) {
        const key = urlKey(url);
        if (queued.has(key)) continue;
        queued.add(key);
        queue.push({ url, discoveredBy: [entry.url], modified: null });
      }
      const resolvedExclusion = source.scope(input.url, plainText(input.title), entry.recordType);
      if (resolvedExclusion) {
        inventory.status = "excluded";
        inventory.reason = resolvedExclusion;
        continue;
      }
      const article = makeArticle(source, input);
      if (!article) {
        inventory.status = "no_prose";
        inventory.reason = "No article text remains after removing executable/interactive content.";
        continue;
      }
      const duplicate = byUrl.get(urlKey(article.source_url)) ?? byId.get(article.id);
      if (duplicate) {
        const retained = result.articles.find((row) => row.id === duplicate)!;
        if (retained.content_sha256 !== article.content_sha256) {
          retained.warnings.push(
            `Alternative source rendering also found at ${entry.url}; the first collected canonical article is retained.`,
          );
        }
        inventory.status = "duplicate";
        inventory.reason = "Same canonical URL or publisher record identifier as another article.";
        inventory.article_id = duplicate;
      } else {
        result.articles.push(article);
        byUrl.set(urlKey(article.source_url), article.id);
        byId.set(article.id, article.id);
        inventory.status = "collected";
        inventory.article_id = article.id;
      }
    } catch (error) {
      inventory.reason = String(error);
      if (error instanceof NonArticleError) inventory.status = "excluded";
      if (error instanceof ProseFetchError) {
        inventory.http_status = error.status;
        inventory.status = fetchDisposition(error);
      }
    }
    done++;
    if (done % 20 === 0)
      progress(`${source.key}: ${done} fetched/converted, ${queue.length} queued, ${result.articles.length} articles`);
  }
  result.articles.sort((a, b) => compareStrings(a.id, b.id));
  result.inventory.sort((a, b) => compareStrings(a.url, b.url));
  progress(
    `${source.key}: ${result.articles.length} articles; ${result.inventory.filter((item) => item.status === "failed").length} processing failures`,
  );
  return result;
}
