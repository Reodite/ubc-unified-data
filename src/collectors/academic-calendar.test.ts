import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Http, Output, selectedCampus, setCampus, USER_AGENT } from "../base.ts";
import { AcademicCalendar, CAMPUSES, RESOURCES } from "./academic-calendar.ts";
import * as cogsmodules from "./cogsmodules.ts";

const moduleHtml = await readFile(new URL("../../test/fixtures/cogs-modules.html", import.meta.url), "utf8");
const moduleStem = "vancouver/cogs_module_courses";

describe("AcademicCalendar collection", () => {
  let root: string;
  let http: Http;
  let out: Output;
  let campus: ReturnType<typeof selectedCampus>;
  let modules: () => Response;
  let requests: string[];
  const network = vi.fn(() => {
    throw new Error("Live network forbidden in calendar tests");
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "academic-calendar-"));
    campus = selectedCampus();
    setCampus("vancouver");
    out = new Output("academic-calendar", root);
    http = new Http({ retries: 0 });
    requests = [];
    modules = () => new Response(moduleHtml);
    vi.stubGlobal("fetch", network);
    http.responder = (method, url) => {
      expect(method).toBe("GET");
      requests.push(url);
      if (url === cogsmodules.URL) return modules();
      for (const host of Object.values(CAMPUSES)) {
        if (url === `https://${host}/jsonapi`)
          return Response.json({
            links: Object.fromEntries(Object.values(RESOURCES).map((r) => [r.replace("/", "--"), {}])),
          });
        const resource = Object.values(RESOURCES).find((r) => url.startsWith(`https://${host}/jsonapi/${r}?`));
        if (resource)
          return Response.json({
            data:
              resource === "node/ubc_page"
                ? [
                    {
                      id: "fixture-program",
                      type: "node--ubc_page",
                      attributes: {
                        title: "Bachelor of Arts",
                        path: { alias: "/bachelor-arts" },
                        body: "Program guidance.",
                      },
                    },
                  ]
                : [],
          });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    };
    vi.spyOn(out, "prune");
  });

  afterEach(async () => {
    try {
      expect(network).not.toHaveBeenCalled();
    } finally {
      setCampus(campus);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      network.mockClear();
      await rm(root, { recursive: true, force: true });
    }
  });

  async function previousModules() {
    const previous = new Output("academic-calendar", root);
    await previous.table(moduleStem, [{ code: "SAVED 300", notes: "Retained fixture output" }]);
    return Promise.all(["json", "csv"].map((suffix) => readFile(join(out.base, `${moduleStem}.${suffix}`))));
  }

  // The updater prunes only after collect resolves; an acquisition or output failure must reach that boundary.
  async function refresh() {
    await new AcademicCalendar().collect(http, out);
    await out.prune();
  }

  it.each(["http403", "network", "challenge", "empty", "missing-section"])(
    "rejects %s before writing output or pruning the previous dataset",
    async (failure) => {
      const previous = await previousModules();
      modules = () => {
        if (failure === "network") throw new Error("Fixture network failure");
        if (failure === "http403") return new Response("Forbidden", { status: 403 });
        if (failure === "challenge") return new Response("<h1>Checking your browser</h1>");
        if (failure === "empty") return new Response("");
        return new Response(moduleHtml.replace("<h4>Historic Modules</h4>", "<h4>Unknown section</h4>"));
      };
      const write = vi.spyOn(out, "json");
      await expect(refresh()).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
      expect(out.prune).not.toHaveBeenCalled();
      expect(out.datasets).toEqual([]);
      expect(
        await Promise.all(["json", "csv"].map((suffix) => readFile(join(out.base, `${moduleStem}.${suffix}`)))),
      ).toEqual(previous);
      expect(requests.filter((url) => url === cogsmodules.URL)).toHaveLength(1);
    },
  );

  it.each(["json", "csv"] as const)(
    "propagates module %s write failures instead of reporting source unavailability",
    async (format) => {
      const previous = await previousModules();
      const failure = new Error("Fixture output write failure");
      if (format === "json") {
        const write = out.json.bind(out);
        vi.spyOn(out, "json").mockImplementation(async (name, payload, options) => {
          if (name === `${moduleStem}.json`) throw failure;
          return write(name, payload, options);
        });
      } else {
        const write = out.csv.bind(out);
        vi.spyOn(out, "csv").mockImplementation(async (name, rows, options) => {
          if (name === `${moduleStem}.csv`) throw failure;
          return write(name, rows, options);
        });
      }
      await expect(refresh()).rejects.toBe(failure);
      expect(out.prune).not.toHaveBeenCalled();
      expect(out.datasets.some((dataset) => dataset.path.endsWith("_unavailable.json"))).toBe(false);
      expect(await readFile(join(out.base, `${moduleStem}.csv`))).toEqual(previous[1]);
    },
  );

  it("writes and tracks both complete module exports with catalog documentation", async () => {
    await previousModules();
    await refresh();
    expect(out.prune).toHaveBeenCalledOnce();
    const rows = JSON.parse(await readFile(join(out.base, `${moduleStem}.json`), "utf8"));
    expect(rows).toHaveLength(139);
    expect(rows.some((row: Record<string, unknown>) => row["code"] === "MDIA 470A" && row["active"] === false)).toBe(
      true,
    );
    expect(await readFile(join(out.base, `${moduleStem}.csv`), "utf8")).toContain("MDIA 470A");
    const datasets = out.datasets.filter((dataset) => dataset.path.includes("cogs_module_courses"));
    expect(datasets).toHaveLength(2);
    for (const dataset of datasets) {
      expect(dataset).toMatchObject({ records: 139, source: cogsmodules.URL });
      expect(dataset.grain).toMatch(/listing/);
      expect(dataset.columns?.["code"]).toMatch(/letter/);
    }
    expect(out.datasets.some((dataset) => dataset.path.endsWith("vancouver/programs.json"))).toBe(true);
    expect(out.datasets.some((dataset) => dataset.path.endsWith("_unavailable.json"))).toBe(false);
  });

  it("does not fetch or publish Vancouver modules for an Okanagan-only run", async () => {
    setCampus("okanagan");
    await refresh();
    expect(requests).not.toContain(cogsmodules.URL);
    expect(out.datasets.every((dataset) => !dataset.path.includes("cogs_module_courses"))).toBe(true);
    expect(out.datasets.some((dataset) => dataset.path.endsWith("okanagan/programs.json"))).toBe(true);
  });
});

it("fetches modules through the existing identified HTTP client", async () => {
  const fetch = vi.fn(async () => new Response(moduleHtml));
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(cogsmodules.fetch(new Http({ retries: 0 }))).resolves.toHaveLength(139);
    expect(fetch).toHaveBeenCalledWith(
      cogsmodules.URL,
      expect.objectContaining({
        headers: { "User-Agent": USER_AGENT },
        method: "GET",
      }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
