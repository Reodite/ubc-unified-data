import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletedHost, Observation, SearchDocument } from "./contracts.ts";
import { formatDocument, sha256 } from "./document-format.ts";
import { verifyHistoricalReady, type VerifyHistoricalReadyOptions } from "./historical-output.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { captureProducer } from "./provenance.ts";
import { HostRecording } from "./recording.ts";

const environment = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const previous = process.env.UBC_TMP_ROOT;
  const boundary = await fs.mkdtemp(path.join(os.tmpdir(), "ubc-historical-output-"));
  process.env.UBC_TMP_ROOT = boundary;
  return { previous, boundary };
});

const native = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Native execution is forbidden");
  }),
);
vi.mock("node:child_process", () => ({ spawn: native, execFile: native, execFileSync: native, execSync: native }));
vi.mock("./pdf-profile.ts", () => ({
  capturePdfProfile: native,
  assertPdfProfile: native,
  loadCachedPdfProfile: native,
}));
vi.mock("./pdf-profile-cache.ts", () => ({ loadCachedPdfProfile: native, readOrCapturePdfProfileCache: native }));
vi.mock("./adapters/pdf.ts", () => ({ extractPdf: native }));

let root: string;
let failed = false;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network is forbidden");
    }),
  );
  await mkdir(DEFAULT_EXTERNAL_ROOT, { recursive: true });
  root = await mkdtemp(join(DEFAULT_EXTERNAL_ROOT, "fixture-"));
});
afterEach(async ({ task }) => {
  expect(native).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  failed ||= task.result?.state === "fail";
  if (task.result?.state !== "fail") await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  if (environment.previous === undefined) delete process.env.UBC_TMP_ROOT;
  else process.env.UBC_TMP_ROOT = environment.previous;
  if (!failed) await rm(environment.boundary, { recursive: true, force: true });
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value)!;
}

async function cacheFixture() {
  const directory = join(root, "pdf-profile-cache");
  await mkdir(directory, { mode: 0o700 });
  const missing = join(root, "archived-resource");
  // A formerly missing resource exists now; historical integrity must not assert current resource identity.
  await writeFile(missing, "different native installation");
  const manifest = {
    schema: "host-pdf-profile-v1",
    platform: "linux",
    architecture: "x64",
    executables: {
      info: "/synthetic/pdfinfo",
      text: "/synthetic/pdftotext",
      limits: "/synthetic/prlimit",
      loader: "/synthetic/loader",
    },
    versions: { "/synthetic/pdfinfo": "synthetic archived version" },
    linkedLibraries: { "/synthetic/pdfinfo": ["/synthetic/library"] },
    resourceRoots: [missing],
    resources: [{ path: missing, kind: "missing" }],
    capabilities: {
      pdftotextHelp: { arguments: ["-h"], stdout: "", stderr: "synthetic help" },
      removeHyphens: "legacy-layout",
    },
    extraction: {
      infoArguments: ["-enc", "UTF-8", "-rawdates"],
      textArguments: ["-layout"],
      limitArguments: ["--core=0", "--"],
      environment: { LC_ALL: "C" },
      fontconfig: "synthetic archived config",
      limits: {
        inputBytes: 67108864,
        outputBytes: 33554432,
        infoBytes: 1048576,
        diagnosticBytes: 262144,
        pages: 500,
        timeoutMs: 30000,
        addressSpaceBytes: 1073741824,
        cpuSeconds: 20,
        openFiles: 64,
      },
      inputName: "input.pdf",
      output: "stdout",
      markdown: "labelled-pages-dynamic-backtick-fences-v1",
    },
    limitations: ["Synthetic historical profile, not executable evidence."],
  };
  const cached = {
    schema: "host-pdf-profile-cache-v1",
    profile: { sha256: sha256(canonical(manifest)), manifest },
    identities: [{ path: missing, lstat: null, stat: null, resolvedPath: null, target: null, entries: null }],
  };
  const receipt = join(directory, "creation.sqlite");
  await writeFile(receipt, "", { mode: 0o600 });
  const database = new DatabaseSync(receipt);
  database.exec("CREATE TABLE profile_cache (id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL)");
  database.close();
  const save = async () => {
    const bytes = Buffer.from(`${JSON.stringify(cached)}\n`);
    const hash = sha256(bytes);
    const path = join(directory, `${hash}.json`);
    await writeFile(path, bytes, { mode: 0o400 });
    const db = new DatabaseSync(receipt);
    try {
      db.prepare("INSERT OR REPLACE INTO profile_cache VALUES (1, ?, ?)").run(hash, bytes.length);
    } finally {
      db.close();
    }
    return path;
  };
  const payload = await save();
  return { directory, receipt, payload, cached, save };
}

async function fixture(pdf = false) {
  const hostname = "historical-fixture.ubc.ca";
  const homeUrl = `https://${hostname}/`;
  const producerRoot = join(root, "producer");
  await mkdir(join(producerRoot, "src"), { recursive: true });
  await writeFile(join(producerRoot, "src/frozen.ts"), "export const original = true;\n");
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"])
    await writeFile(join(producerRoot, file), "{}\n");
  const producer = await captureProducer(producerRoot);
  const directory = join(root, "recording");
  await mkdir(directory);
  const seed = Buffer.from(JSON.stringify({ hostname, urls: [] }));
  await writeFile(join(directory, "seed.json"), seed);
  const rawPdf = Buffer.from("%PDF-1.4\nsynthetic retained binary; no native parser is used\n");
  const recording = await HostRecording.open({
    hostname,
    directory,
    producer,
    seedSha256: sha256(seed),
    acquire: true,
    minimumMs: 1,
    documentFormats: ["pdf"],
    documentUrlAllowed: () => true,
    fetcher: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/robots.txt")
        return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
      if (path === "/redirect") return new Response(null, { status: 302, headers: { location: homeUrl } });
      if (path === "/z-redirect") return new Response(null, { status: 302, headers: { location: `${homeUrl}z-only` } });
      if (path === "/file.pdf") return new Response(rawPdf, { headers: { "content-type": "application/pdf" } });
      return new Response(`<html><title>Public guidance</title><main>${path} synthetic recorded HTML</main></html>`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  let home: Observation;
  let binary: Observation | undefined;
  let seal: string;
  try {
    home = await recording.read(homeUrl);
    await recording.read(`${homeUrl}duplicate`);
    await recording.read(`${homeUrl}redirect`);
    await recording.read(`${homeUrl}z-redirect`);
    if (pdf) binary = await recording.read(`${homeUrl}file.pdf`);
    seal = await recording.seal();
  } finally {
    recording.close();
  }
  const cache = pdf ? await cacheFixture() : undefined;
  const profileHash = cache?.cached.profile.sha256 ?? null;
  const input = sha256(
    JSON.stringify({ recording: seal, seed: sha256(seed), ...(profileHash ? { pdf_profile: profileHash } : {}) }),
  );
  const document = (observed: Observation, title: string, body: string): SearchDocument => ({
    id: `documents:official-web:${sha256(observed.snapshot.url).slice(0, 24)}`,
    hostname,
    title,
    source_url: observed.snapshot.url,
    retrieved_at: observed.snapshot.retrieved_at,
    source_modified_at: null,
    snapshot_sha256: observed.sha256,
    input_sha256: input,
    body_sha256: sha256(body),
    content_sha256: sha256(`${title}\n${body}`),
    content_markdown: body,
    alternate_urls: [],
    warnings: [],
    producer: structuredClone(producer),
  });
  const html = document(home!, "Public guidance", "Preserved public guidance.\n");
  html.alternate_urls = [`${homeUrl}duplicate`, `${homeUrl}redirect`];
  const documents = [html];
  if (binary) {
    const pdfDoc = document(
      binary,
      "Original PDF title",
      "## Page 1\n\n````text\nPrinted ``` markers\n## Page 999\n````\n\n## Page 2\n\n```text\nRetained second page.\n```\n",
    );
    pdfDoc.extraction = {
      format: "pdf",
      source_bytes_sha256: binary.snapshot.binary!.sha256,
      source_bytes: rawPdf.length,
      pages: 2,
      profile_sha256: profileHash!,
    };
    documents.push(pdfDoc);
  }
  documents.sort((a, b) => a.id.localeCompare(b.id));
  const completed: CompletedHost = {
    complete: true,
    documents,
    host: {
      hostname,
      title: hostname,
      homepage_url: homeUrl,
      homepage_retrieved_at: home!.snapshot.retrieved_at,
      homepage_sha256: home!.sha256,
      scope: "Public HTML prose and native PDF text on this exact hostname.",
      document_root: `data/documents/${hostname}`,
      document_count: documents.length,
    },
  };
  const ready = {
    version: 1,
    hostname,
    recording_seal: seal!,
    seed_sha256: sha256(seed),
    pdf_profile_sha256: profileHash,
    completed,
  };
  const options: VerifyHistoricalReadyOptions = {
    hostname,
    readyPath: join(directory, "ready.json"),
    readySha256: "",
    recordingDirectory: directory,
    producerRoot,
    producer,
    ...(cache ? { archivedPdfCacheDirectory: cache.directory } : {}),
  };
  const save = async () => {
    const bytes = Buffer.from(`${JSON.stringify(ready, null, 2)}\n`);
    await writeFile(options.readyPath, bytes);
    options.readySha256 = sha256(bytes);
  };
  await save();
  const updateState = (sql: string) => {
    const db = new DatabaseSync(join(directory, "state.sqlite"));
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const reseal = async () => {
    await rm(join(directory, "seal.json"));
    const replay = await HostRecording.open({
      hostname,
      directory,
      producer,
      seedSha256: ready.seed_sha256,
      acquire: false,
    });
    try {
      ready.recording_seal = await replay.seal();
    } finally {
      replay.close();
    }
    const digest = sha256(
      JSON.stringify({
        recording: ready.recording_seal,
        seed: ready.seed_sha256,
        ...(ready.pdf_profile_sha256 ? { pdf_profile: ready.pdf_profile_sha256 } : {}),
      }),
    );
    for (const doc of documents) doc.input_sha256 = digest;
    await save();
  };
  vi.spyOn(HostRecording.prototype, "read").mockImplementation(() => {
    throw new Error("Logical request reads are forbidden");
  });
  vi.spyOn(HostRecording.prototype, "readDocument").mockImplementation(() => {
    throw new Error("Document request reads are forbidden");
  });
  return {
    options,
    ready,
    save,
    completed,
    html,
    pdf: documents.find((doc) => doc.extraction),
    directory,
    cache,
    home: home!,
    updateState,
    reseal,
  };
}

async function treeBytes(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    const key = `${prefix}${item.name}`;
    if (item.isDirectory()) Object.assign(result, await treeBytes(path, `${key}/`));
    else result[key] = sha256(await readFile(path));
  }
  return result;
}

function setBody(document: SearchDocument, body: string) {
  document.content_markdown = body;
  document.body_sha256 = sha256(body);
  document.content_sha256 = sha256(`${document.title}\n${body}`);
}

async function expectLockReleased(directory: string) {
  const db = new DatabaseSync(join(directory, "owner.sqlite"));
  try {
    db.exec("BEGIN IMMEDIATE; ROLLBACK");
  } finally {
    db.close();
  }
}

describe("historical ready output integrity", () => {
  it.each([false, true])("preserves legacy output and archived producer/profile bytes (PDF=%s)", async (pdf) => {
    const f = await fixture(pdf);
    const before = await treeBytes(root);
    const expected = f.completed.documents.map((doc) => formatDocument(doc));
    const first = await verifyHistoricalReady(f.options);
    expect(first).toEqual(f.completed);
    expect(first.documents.map((doc) => formatDocument(doc))).toEqual(expected);
    first.documents[0]!.title = "caller mutation cannot alter the next read";
    expect(await verifyHistoricalReady(f.options)).toEqual(f.completed);
    expect(await treeBytes(root)).toEqual(before);
    await expectLockReleased(f.directory);
  });

  it("accepts coalesced physical redirect endpoints backed by logical outcomes", async () => {
    const f = await fixture();
    const url = f.html.source_url;
    f.html.alternate_urls.push(`${url}z-only`, `${url}z-redirect`);
    f.html.alternate_urls.sort();
    await f.save();
    const db = new DatabaseSync(join(f.directory, "state.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT 1 FROM outcomes WHERE url=?").get(`${url}z-only`)).toBeUndefined();
    } finally {
      db.close();
    }
    expect(await verifyHistoricalReady(f.options)).toEqual(f.completed);
  });

  it("checks non-document attempt bodies, not just selected document snapshots", async () => {
    const f = await fixture();
    await writeFile(join(f.directory, "objects", `${sha256("User-agent: *\nAllow: /\n")}.body`), "changed");
    await expect(verifyHistoricalReady(f.options)).rejects.toThrow("raw body changed");
    await expectLockReleased(f.directory);
  });

  it.each([
    [
      "ready hash",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.options.readySha256 = "a".repeat(64);
      },
      /Ready result bytes/,
    ],
    [
      "owner",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.ready.hostname = "different.ubc.ca";
      },
      /owner/,
    ],
    [
      "version",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.ready.version = 2;
      },
      /version/,
    ],
    [
      "ready unknown",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        Object.assign(f.ready, { unknown: true });
      },
      /ready output fields/,
    ],
    [
      "completed unknown",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        Object.assign(f.completed, { unknown: true });
      },
      /completed host fields/,
    ],
    [
      "host unknown",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        Object.assign(f.completed.host, { unknown: true });
      },
      /vetted host fields/,
    ],
    [
      "document unknown",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        Object.assign(f.html, { unknown: true });
      },
      /document fields/,
    ],
    [
      "producer unknown",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        Object.assign(f.html.producer, { unknown: true });
      },
      /producer fields/,
    ],
    [
      "count",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.completed.host.document_count++;
      },
      /count/,
    ],
    [
      "incomplete",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        Object.assign(f.completed, { complete: false });
      },
      /Incomplete/,
    ],
    [
      "input",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.html.input_sha256 = "b".repeat(64);
      },
      /input binding/,
    ],
    [
      "body",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.html.content_markdown += "tampered";
      },
      /digest mismatch/,
    ],
    [
      "retrieval",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.html.retrieved_at = "2001-01-01T00:00:00.000Z";
      },
      /retrieval/,
    ],
    [
      "citation",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.html.source_url += "invented";
        f.html.id = `documents:official-web:${sha256(f.html.source_url).slice(0, 24)}`;
      },
      /citation/,
    ],
    [
      "document producer",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.html.producer.inputs_sha256 = "b".repeat(64);
      },
      /Producer inputs/,
    ],
    [
      "runtime",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.options.producer.runtime.node = "24.0.0";
      },
      /Producer inputs/,
    ],
    [
      "alias",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.html.alternate_urls = [`https://${f.options.hostname}/unobserved`];
      },
      /alternate URL/,
    ],
    [
      "homepage time",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.completed.host.homepage_retrieved_at = "2001-01-01T00:00:00.000Z";
      },
      /homepage provenance/,
    ],
  ] as const)("rejects tampered %s even with a refreshed test ready receipt", async (name, mutate, error) => {
    const f = await fixture();
    mutate(f);
    if (name !== "ready hash") await f.save();
    await expect(verifyHistoricalReady(f.options)).rejects.toThrow(error);
    await expectLockReleased(f.directory);
  });

  it.each(["seed", "seal", "seal unknown", "snapshot", "raw body", "producer", "state", "dispatching", "uncertain"])(
    "rereads immutable %s evidence on each invocation",
    async (what) => {
      const f = await fixture();
      await verifyHistoricalReady(f.options);
      if (what === "seed")
        await writeFile(
          join(f.directory, "seed.json"),
          JSON.stringify({ hostname: f.options.hostname, urls: [{ url: "changed" }] }),
        );
      if (what === "seal" || what === "seal unknown") {
        const seal = JSON.parse(await readFile(join(f.directory, "seal.json"), "utf8"));
        if (what === "seal") seal.input_sha256 = "f".repeat(64);
        else seal.unknown = true;
        await writeFile(join(f.directory, "seal.json"), JSON.stringify(seal));
      }
      if (what === "snapshot") await writeFile(join(f.directory, "objects", `${f.home.sha256}.json`), "{}");
      if (what === "raw body")
        await writeFile(join(f.directory, "objects", `${sha256(f.home.snapshot.body)}.body`), "changed");
      if (what === "producer") await writeFile(join(f.options.producerRoot, "src/frozen.ts"), "changed");
      if (what === "state") f.updateState("UPDATE attempts SET started='changed' WHERE id=1");
      if (what === "dispatching") f.updateState("UPDATE attempts SET state='dispatching' WHERE id=1");
      if (what === "uncertain") {
        f.updateState("UPDATE attempts SET state='uncertain' WHERE id=1");
        await f.reseal();
      }
      await expect(verifyHistoricalReady(f.options)).rejects.toThrow();
      await expectLockReleased(f.directory);
    },
  );

  it("rejects a valid foreign snapshot object not referenced by the sealed recording", async () => {
    const f = await fixture();
    const foreign = { ...f.home.snapshot, retrieved_at: "2001-01-01T00:00:00.000Z" };
    const bytes = Buffer.from(JSON.stringify(foreign));
    const hash = sha256(bytes);
    await writeFile(join(f.directory, "objects", `${hash}.json`), bytes);
    f.html.snapshot_sha256 = hash;
    f.html.retrieved_at = foreign.retrieved_at;
    await f.save();
    await expect(verifyHistoricalReady(f.options)).rejects.toThrow("not a member");
    await expectLockReleased(f.directory);
  });

  it.each(["ID", "content", "URL"])("rejects duplicate %s without coalescing", async (kind) => {
    const f = await fixture();
    const duplicate = structuredClone(f.html);
    if (kind !== "ID") {
      const db = new DatabaseSync(join(f.directory, "state.sqlite"), { readOnly: true });
      try {
        duplicate.snapshot_sha256 = String(
          db.prepare("SELECT snapshot FROM outcomes WHERE url=?").get(`${f.html.source_url}duplicate`)!.snapshot,
        );
      } finally {
        db.close();
      }
      const snapshot = JSON.parse(
        await readFile(join(f.directory, "objects", `${duplicate.snapshot_sha256}.json`), "utf8"),
      );
      duplicate.source_url = snapshot.url;
      duplicate.id = `documents:official-web:${sha256(duplicate.source_url).slice(0, 24)}`;
      duplicate.retrieved_at = snapshot.retrieved_at;
      duplicate.alternate_urls = [];
      if (kind === "URL") {
        duplicate.title = "Distinct title";
        setBody(duplicate, "Distinct content.");
      }
    }
    (f.completed.documents as SearchDocument[]).push(duplicate);
    f.completed.host.document_count++;
    await f.save();
    await expect(verifyHistoricalReady(f.options)).rejects.toThrow("Duplicate ready document");
  });

  it.each([
    "missing cache",
    "missing receipt",
    "receipt",
    "payload",
    "writable payload",
    "manifest",
    "cache unknown",
    "manifest unknown",
    "identity unknown",
    "receipt unknown",
    "profile binding",
    "source bytes",
    "byte count",
    "pages",
    "page text",
    "no extraction",
    "no ready profile",
    "extraction unknown",
  ])("rejects PDF %s without native execution", async (what) => {
    const f = await fixture(true);
    await verifyHistoricalReady(f.options);
    if (what === "missing cache") delete f.options.archivedPdfCacheDirectory;
    if (what === "missing receipt") await rm(f.cache!.receipt);
    if (what === "receipt") {
      const db = new DatabaseSync(f.cache!.receipt);
      try {
        db.exec("UPDATE profile_cache SET bytes=bytes+1");
      } finally {
        db.close();
      }
    }
    if (what === "payload") {
      await chmod(f.cache!.payload, 0o600);
      await writeFile(f.cache!.payload, "tampered");
      await chmod(f.cache!.payload, 0o400);
    }
    if (what === "writable payload") await chmod(f.cache!.payload, 0o600);
    if (what === "manifest") {
      f.cache!.cached.profile.manifest.extraction.textArguments.push("changed");
      await f.cache!.save();
    }
    if (what === "cache unknown") {
      Object.assign(f.cache!.cached, { unknown: true });
      await f.cache!.save();
    }
    if (what === "manifest unknown") {
      Object.assign(f.cache!.cached.profile.manifest, { unknown: true });
      await f.cache!.save();
    }
    if (what === "identity unknown") {
      Object.assign(f.cache!.cached.identities[0]!, { unknown: true });
      await f.cache!.save();
    }
    if (what === "receipt unknown") {
      const db = new DatabaseSync(f.cache!.receipt);
      try {
        db.exec("ALTER TABLE profile_cache ADD COLUMN unknown TEXT");
      } finally {
        db.close();
      }
    }
    if (what === "profile binding") f.pdf!.extraction!.profile_sha256 = "e".repeat(64);
    if (what === "source bytes") f.pdf!.extraction!.source_bytes_sha256 = "e".repeat(64);
    if (what === "byte count") f.pdf!.extraction!.source_bytes++;
    if (what === "pages") f.pdf!.extraction!.pages++;
    if (what === "page text") setBody(f.pdf!, f.pdf!.content_markdown.replace("## Page 2", "## Page 3"));
    if (what === "no extraction") delete f.pdf!.extraction;
    if (what === "no ready profile") f.ready.pdf_profile_sha256 = null;
    if (what === "extraction unknown") Object.assign(f.pdf!.extraction!, { unknown: true });
    await f.save();
    await expect(verifyHistoricalReady(f.options)).rejects.toThrow();
    await expectLockReleased(f.directory);
  });

  it("checks binary bytes even when only the raw object is tampered", async () => {
    const f = await fixture(true);
    await writeFile(join(f.directory, "objects", `${f.pdf!.extraction!.source_bytes_sha256}.body`), "changed");
    await expect(verifyHistoricalReady(f.options)).rejects.toThrow(/binary body|raw body/);
  });

  it("requires stable regular ready bytes and does not create missing evidence", async () => {
    const f = await fixture();
    const link = join(root, "ready-link.json");
    await symlink(f.options.readyPath, link);
    await expect(verifyHistoricalReady({ ...f.options, readyPath: link })).rejects.toThrow(/Symlink/);
    await rm(f.options.readyPath);
    await expect(verifyHistoricalReady(f.options)).rejects.toThrow();
    await expect(lstat(f.options.readyPath)).rejects.toThrow();
  });
});
