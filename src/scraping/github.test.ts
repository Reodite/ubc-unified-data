import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Geospatial } from "../collectors/geospatial.ts";
import { Grades, SRC_DIR } from "../collectors/grades.ts";
import { selectedCampus, setCampus } from "../core/campus.ts";
import { Http } from "../core/http.ts";
import { Output } from "../core/output.ts";
import { githubSnapshot } from "./github.ts";

const SHA = "a".repeat(40);
const PARKING_SHA = "b".repeat(40);
const DATE = "2025-01-02T03:04:05Z";
const roots: string[] = [];
const campus = selectedCampus();

interface RepositoryFixture {
  branch?: string | null;
  sha: string;
  commitDate?: string;
  tree?: Array<{ type: string; path?: string }>;
  truncated?: boolean;
  files?: Record<string, string | Uint8Array>;
}

function mockGithub(repositories: Record<string, RepositoryFixture>) {
  const routes = new Map<string, () => Response>();
  for (const [slug, repo] of Object.entries(repositories)) {
    const api = `https://api.github.com/repos/${slug}`;
    routes.set(api, () => Response.json({ default_branch: repo.branch }));
    routes.set(`${api}/commits/${repo.branch ?? "master"}`, () =>
      Response.json({ sha: repo.sha, commit: { committer: { date: repo.commitDate } } }),
    );
    routes.set(`${api}/git/trees/${repo.sha}?recursive=1`, () =>
      Response.json({ tree: repo.tree, truncated: repo.truncated }),
    );
    for (const [path, content] of Object.entries(repo.files ?? {})) {
      routes.set(
        `https://raw.githubusercontent.com/${slug}/${repo.sha}/${path}`,
        () => new Response(typeof content === "string" ? content : new Uint8Array(content)),
      );
    }
  }
  const http = new Http({ retries: 0 });
  const responder = vi.fn((method: string, url: string) => {
    expect(method).toBe("GET");
    const respond = routes.get(url);
    if (!respond) throw new Error(`Unexpected request: ${url}`);
    return respond();
  });
  http.responder = responder;
  return { http, responder };
}

async function output(folder: string): Promise<Output> {
  const root = await mkdtemp(join(tmpdir(), "github-snapshot-"));
  roots.push(root);
  return new Output(folder, root);
}

async function json(out: Output, path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(out.base, path), "utf8"));
}

afterEach(async () => {
  setCampus(campus);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("githubSnapshot", () => {
  it("uses the default branch, keeps only blobs in tree order, and pins URLs to its head", async () => {
    const { http, responder } = mockGithub({
      "owner/repo": {
        branch: "main",
        sha: SHA,
        commitDate: DATE,
        tree: [
          { type: "blob", path: "z.csv" },
          { type: "tree", path: "folder" },
          { type: "commit", path: "submodule" },
          { type: "blob", path: "folder/a.json" },
        ],
      },
    });
    const snapshot = await githubSnapshot(http, "owner/repo");
    expect(snapshot).toMatchObject({ branch: "main", sha: SHA, commitDate: DATE, paths: ["z.csv", "folder/a.json"] });
    expect(snapshot.rawUrl("folder/a.json")).toBe(`https://raw.githubusercontent.com/owner/repo/${SHA}/folder/a.json`);
    expect(snapshot.blobUrl("folder/a.json")).toBe(`https://github.com/owner/repo/blob/${SHA}/folder/a.json`);
    expect(responder.mock.calls.map(([, url]) => url)).toEqual([
      "https://api.github.com/repos/owner/repo",
      "https://api.github.com/repos/owner/repo/commits/main",
      `https://api.github.com/repos/owner/repo/git/trees/${SHA}?recursive=1`,
    ]);
  });

  it.each([undefined, null])("falls back to master for default_branch=%s", async (branch) => {
    const { http, responder } = mockGithub({ "owner/repo": { branch, sha: SHA } });
    const snapshot = await githubSnapshot(http, "owner/repo");
    expect(snapshot).toMatchObject({ branch: "master", sha: SHA, commitDate: undefined, paths: [] });
    expect(responder).toHaveBeenNthCalledWith(2, "GET", "https://api.github.com/repos/owner/repo/commits/master", null);
  });

  it("rejects a truncated tree rather than returning a partial snapshot", async () => {
    const { http, responder } = mockGithub({
      "owner/repo": { branch: "main", sha: SHA, truncated: true, tree: [{ type: "blob", path: "partial.csv" }] },
    });
    await expect(githubSnapshot(http, "owner/repo")).rejects.toThrow(
      "GitHub truncated owner/repo's file tree; it outgrew one listing",
    );
    expect(responder).toHaveBeenCalledTimes(3);
  });
});

describe("snapshot collectors", () => {
  it("writes grade CSVs in tree order with LF and a sorted, SHA-cited distribution table", async () => {
    const slug = "DonneyF/ubc-pair-grade-data";
    const header = "Campus,Year,Session,Subject,Course,Detail,Section,Title,Reported,Avg,90-100\r\n";
    const z = `${header}UBCV,2024,W,ZOOL,100,,001,Zoology,20,95,16\r\nUBCV,2024,W,ZOOL,100,,OVERALL,Total,20,95,16\r\n`;
    const a = `${header}UBCV,2023,S,ACAM,390,,002,Arts,10,90,8\r\nUBCO,2023,S,ACAM,390,,003,Arts,10,90,8\r\nUBCV,2023,S,ACAM,390,D,004,Arts,10,90,8\r\n`;
    const { http } = mockGithub({
      [slug]: {
        branch: "main",
        sha: SHA,
        tree: [
          { type: "blob", path: `${SRC_DIR}/z.csv` },
          { type: "tree", path: `${SRC_DIR}/directory.csv` },
          { type: "commit", path: `${SRC_DIR}/submodule.csv` },
          { type: "blob", path: "tableau-dashboard-v2/UBCO/ignored.csv" },
          { type: "blob", path: `${SRC_DIR}-extra/ignored.csv` },
          { type: "blob", path: `${SRC_DIR}/ignored.CSV` },
          { type: "blob", path: `${SRC_DIR}/ignored.json` },
          { type: "blob", path: `${SRC_DIR}/nested/a.csv` },
        ],
        files: { [`${SRC_DIR}/z.csv`]: z, [`${SRC_DIR}/nested/a.csv`]: a },
      },
    });
    const map = vi.spyOn(http, "map");
    const out = await output("grades");
    await new Grades().collect(http, out);

    expect(map).toHaveBeenCalledWith(expect.any(Function), [`${SRC_DIR}/z.csv`, `${SRC_DIR}/nested/a.csv`], 8);
    expect(out.datasets.map(({ path, source }) => ({ path, source }))).toEqual([
      { path: "grades/raw/z.csv", source: `https://github.com/${slug}/blob/${SHA}/${SRC_DIR}/z.csv` },
      { path: "grades/raw/nested/a.csv", source: `https://github.com/${slug}/blob/${SHA}/${SRC_DIR}/nested/a.csv` },
      { path: "grades/distributions.json", source: `https://github.com/${slug}/tree/${SHA}/${SRC_DIR}` },
    ]);
    expect(await readFile(join(out.base, "raw/z.csv"), "utf8")).toBe(z.replaceAll("\r\n", "\n"));
    expect(await readFile(join(out.base, "raw/nested/a.csv"), "utf8")).toBe(a.replaceAll("\r\n", "\n"));
    expect(await json(out, "distributions.json")).toEqual([
      expect.objectContaining({
        year: 2023,
        subject: "ACAM",
        section: "002",
        distribution: expect.objectContaining({ "90-100": 8 }),
      }),
      expect.objectContaining({
        year: 2024,
        subject: "ZOOL",
        section: "001",
        distribution: expect.objectContaining({ "90-100": 16 }),
      }),
    ]);
    expect((await readFile(join(out.base, "distributions.json"), "utf8")).trim().split("\n")).toHaveLength(4);
  });

  it.each(["vancouver", "okanagan", "both"])(
    "preserves geospatial mounts, bytes and provenance for %s",
    async (selection) => {
      setCampus(selection);
      const slug = "UBCGeodata/ubc-geospatial-opendata";
      const parkingSlug = "UBCGeodata/ubcv-parking";
      const csv = "NAME,LAT,LONG\r\nBuilding,-123.25,49.26\r\n";
      const geojson = '{"type":"FeatureCollection","features":[]}\r\n';
      const parking = "NAME,SPACES\r\nLot,20\r\n";
      const archive = new Uint8Array([0, 255, 13, 10, 128]);
      const { http } = mockGithub({
        [slug]: {
          branch: "main",
          sha: SHA,
          commitDate: DATE,
          tree: [
            { type: "blob", path: "ubcv/locations/csv/z.csv" },
            { type: "blob", path: "ubco/roads/roads.GeoJSON" },
            { type: "tree", path: "ubcv/directory.csv" },
            { type: "commit", path: "ubcv/submodule.csv" },
            { type: "blob", path: ".github/config.json" },
            { type: "blob", path: "ubcv/readme.md" },
            { type: "blob", path: "metadata/fields.json" },
          ],
          files: {
            "ubcv/locations/csv/z.csv": csv,
            "ubco/roads/roads.GeoJSON": geojson,
            "metadata/fields.json": "{}\n",
          },
        },
        [parkingSlug]: {
          sha: PARKING_SHA,
          commitDate: DATE,
          tree: [
            { type: "blob", path: "csv/parking.CSV" },
            { type: "blob", path: "metadata/archive.zip" },
          ],
          files: { "csv/parking.CSV": parking, "metadata/archive.zip": archive },
        },
      });
      const map = vi.spyOn(http, "map");
      const out = await output("geospatial");
      await new Geospatial().collect(http, out);

      const vancouver = selection !== "okanagan";
      const okanagan = selection !== "vancouver";
      const paths = [
        ...(vancouver ? ["ubcv/locations/csv/z.csv"] : []),
        ...(okanagan ? ["ubco/roads/roads.GeoJSON"] : []),
        "metadata/fields.json",
        ...(vancouver ? ["ubcv/parking/csv/parking.CSV", "ubcv/parking/metadata/archive.zip"] : []),
      ];
      expect(out.datasets.map(({ path }) => path)).toEqual([
        ...paths.map((path) => `geospatial/${path}`),
        "geospatial/_index.json",
        "geospatial/_index.csv",
        "geospatial/_source.json",
      ]);
      expect(map).toHaveBeenCalledTimes(2);
      expect(map.mock.calls.map(([, , workers]) => workers)).toEqual([8, 8]);
      for (const path of paths) {
        const isParking = path.startsWith("ubcv/parking/");
        expect(out.datasets.find((dataset) => dataset.path === `geospatial/${path}`)?.source).toBe(
          isParking
            ? `https://github.com/${parkingSlug}/blob/${PARKING_SHA}/${path.slice("ubcv/parking/".length)}`
            : `https://github.com/${slug}/blob/${SHA}/${path}`,
        );
      }
      if (vancouver) {
        expect(await readFile(join(out.base, "ubcv/locations/csv/z.csv"), "utf8")).toBe(
          "NAME,LONG,LAT\nBuilding,-123.25,49.26\r\n",
        );
        expect(await readFile(join(out.base, "ubcv/parking/csv/parking.CSV"), "utf8")).toBe(parking);
        expect(new Uint8Array(await readFile(join(out.base, "ubcv/parking/metadata/archive.zip")))).toEqual(archive);
      }
      if (okanagan) expect(await readFile(join(out.base, "ubco/roads/roads.GeoJSON"), "utf8")).toBe(geojson);
      expect(await readFile(join(out.base, "metadata/fields.json"), "utf8")).toBe("{}\n");
      expect(await json(out, "_index.json")).toEqual([
        ...(vancouver
          ? [
              {
                path: "ubcv/locations/csv/z.csv",
                campus: "ubcv",
                theme: "locations",
                format: "csv",
                name: "z",
                repository: "ubc-geospatial-opendata",
              },
            ]
          : []),
        ...(okanagan
          ? [
              {
                path: "ubco/roads/roads.GeoJSON",
                campus: "ubco",
                theme: "roads",
                format: "geojson",
                name: "roads",
                repository: "ubc-geospatial-opendata",
              },
            ]
          : []),
        {
          path: "metadata/fields.json",
          campus: "metadata",
          theme: "fields.json",
          format: "json",
          name: "fields",
          repository: "ubc-geospatial-opendata",
        },
        ...(vancouver
          ? [
              {
                path: "ubcv/parking/csv/parking.CSV",
                campus: "ubcv",
                theme: "parking",
                format: "csv",
                name: "parking",
                repository: "ubcv-parking",
              },
              {
                path: "ubcv/parking/metadata/archive.zip",
                campus: "ubcv",
                theme: "parking",
                format: "zip",
                name: "archive",
                repository: "ubcv-parking",
              },
            ]
          : []),
      ]);
      expect(await json(out, "_source.json")).toEqual({
        repositories: [
          {
            repository: `https://github.com/${slug}`,
            branch: "main",
            commit: SHA,
            commit_date: DATE,
            mounted_at: "/",
            files: 1 + Number(vancouver) + Number(okanagan),
          },
          {
            repository: `https://github.com/${parkingSlug}`,
            branch: "master",
            commit: PARKING_SHA,
            commit_date: DATE,
            mounted_at: "ubcv/parking",
            files: vancouver ? 2 : 0,
          },
        ],
        retrieved_at: expect.any(String),
        corrections: vancouver
          ? { swapped_lat_long_headers: ["ubcv/locations/csv/z.csv"], note: expect.any(String) }
          : {},
      });
    },
  );
});
