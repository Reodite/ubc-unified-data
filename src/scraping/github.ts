import type { Http } from "../core/http.ts";

export interface GithubSnapshot {
  branch: string;
  sha: string;
  commitDate: string | undefined;
  paths: string[];
  rawUrl(path: string): string;
  blobUrl(path: string): string;
}

/** List blobs in tree order and pin downloads and citations to the default branch's head. */
export async function githubSnapshot(http: Http, slug: string): Promise<GithubSnapshot> {
  const meta = (await http.getJson(`https://api.github.com/repos/${slug}`)) as { default_branch?: string };
  const branch = meta.default_branch ?? "master";
  const head = (await http.getJson(`https://api.github.com/repos/${slug}/commits/${branch}`)) as {
    sha: string;
    commit?: { committer?: { date?: string } };
  };
  const sha = head.sha;
  const tree = (await http.getJson(`https://api.github.com/repos/${slug}/git/trees/${sha}`, {
    params: { recursive: "1" },
  })) as { truncated?: boolean; tree?: Array<{ type: string; path?: string }> };
  if (tree.truncated) {
    throw new Error(`GitHub truncated ${slug}'s file tree; it outgrew one listing`);
  }

  return {
    branch,
    sha,
    commitDate: head.commit?.committer?.date,
    paths: (tree.tree ?? []).filter((node) => node.type === "blob").map((node) => node.path ?? ""),
    rawUrl: (path) => `https://raw.githubusercontent.com/${slug}/${sha}/${path}`,
    blobUrl: (path) => `https://github.com/${slug}/blob/${sha}/${path}`,
  };
}
