import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "./categories.ts";
import type { CompletedHost, SearchDocument } from "./contracts.ts";
import { documentFilename, formatDocument, parseDocument, sha256 } from "./document-format.ts";
import { assertExternalPath, EXTERNAL_BOUNDARY } from "./paths.ts";
import { hostDocumentRoots, validatePublishedHosts } from "./public-validation.ts";
import {
  publishCompletedHost,
  withdrawPublishedHost,
  type PublicationBoundary,
  type PublishCompletedHostOptions,
  type WithdrawPublishedHostOptions,
} from "./publication.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

const TEMP = EXTERNAL_BOUNDARY;
const roots: string[] = [];
const children = new Set<ChildProcess>();
const BOUNDARIES: PublicationBoundary[] = [
  "locked",
  "journal-written",
  "prepared",
  "inputs-verified",
  "parents-created",
  "old-host-moved",
  "new-host-installed",
  "old-list-moved",
  "new-list-installed",
  "before-commit",
  "commit-prepared",
  "committed",
  "before-cleanup",
];
const AFTER_COMMIT = new Set<PublicationBoundary>(["committed", "before-cleanup"]);

afterEach(async (context) => {
  for (const child of children) {
    child.kill("SIGKILL");
    await exited(child);
  }
  children.clear();
  vi.mocked(rename).mockReset();
  vi.mocked(open).mockReset();
  for (const root of roots.splice(0)) {
    if (context.task.result?.state === "fail") console.error(`Preserved publication fixture: ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
});

function complete(hostname = "example.ubc.ca", body = "Original **source** prose.\n", route = "/page"): CompletedHost {
  const source_url = `https://${hostname}${route}`;
  const title = "Original source title";
  const doc: SearchDocument = {
    id: `documents:official-web:${sha256(source_url).slice(0, 24)}`,
    hostname,
    title,
    source_url,
    retrieved_at: "2026-01-02T03:04:05.000Z",
    source_modified_at: null,
    snapshot_sha256: sha256("snapshot"),
    input_sha256: sha256("input"),
    body_sha256: sha256(body),
    content_sha256: sha256(`${title}\n${body}`),
    content_markdown: body,
    warnings: [],
    alternate_urls: [],
    producer: {
      inputs_sha256: sha256("producer"),
      runtime: { node: "v26.8.1", icu: "78.2", unicode: "17.0", platform: "linux", arch: "x64" },
    },
  };
  return {
    complete: true,
    host: {
      hostname,
      title: "Example UBC",
      homepage_url: `https://${hostname}/`,
      homepage_retrieved_at: doc.retrieved_at,
      homepage_sha256: sha256("homepage"),
      scope: "Public institutional prose",
      document_root: `data/documents/${hostname}`,
      document_count: 1,
    },
    documents: [doc],
  };
}

async function setup() {
  await mkdir(assertExternalPath(TEMP), { recursive: true });
  const root = await mkdtemp(join(TEMP, "text-publication-test-"));
  roots.push(root);
  const repositoryRoot = join(root, "repo");
  const externalRoot = join(root, "external");
  await mkdir(repositoryRoot);
  const options: PublishCompletedHostOptions = {
    repositoryRoot,
    externalRoot,
    registeredHosts: ["example.ubc.ca", "other.ubc.ca"],
    completed: complete(),
    verifyInputs: async () => {},
  };
  const workspace = join(externalRoot, `host-publication-${sha256(repositoryRoot)}`);
  return {
    root,
    options,
    workspace,
    file: join(
      repositoryRoot,
      options.completed.host.document_root!,
      documentFilename(options.completed.documents[0]!.id),
    ),
  };
}

async function tree(root: string, inode = false): Promise<unknown[]> {
  const entries: unknown[] = [];
  async function visit(path: string, name: string): Promise<void> {
    const stat = await lstat(path);
    entries.push([
      name,
      stat.mode & 0o7777,
      ...(inode ? [stat.ino] : []),
      stat.isSymbolicLink() ? await readlink(path) : stat.isFile() ? (await readFile(path)).toString("base64") : null,
    ]);
    if (stat.isDirectory())
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), `${name}/${child}`);
  }
  await visit(root, "");
  return entries;
}

async function cleanWorkspace(workspace: string): Promise<void> {
  expect((await readdir(workspace)).sort()).toEqual(["lock.sqlite"]);
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function preparedChild(options: PublishCompletedHostOptions | WithdrawPublishedHostOptions, occurrence = 1) {
  const module = fileURLToPath(new URL("./publication.ts", import.meta.url));
  const { verifyInputs: _, ...data } = options;
  const script = `import {publishCompletedHost,withdrawPublishedHost} from ${JSON.stringify(module)};
    process.stdout.write('BOOTED\\n');
    const stop = await new Promise(resolve=>process.once('message',resolve));
    let seen = 0;
    await ${"completed" in options ? "publishCompletedHost" : "withdrawPublishedHost"}({...${JSON.stringify(data)}, verifyInputs: async()=>{}, testHook: async(boundary)=>{
      if(boundary===stop && ++seen === ${occurrence}) { process.stdout.write('READY\\n'); await new Promise(()=>setInterval(()=>{},1000)); }
    }});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, TMPDIR: TEMP },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  let output = "";
  let errors = "";
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    errors += String(chunk);
  });
  const waitFor = (token: string) =>
    new Promise<void>((resolve, reject) => {
      if (output.includes(token)) {
        resolve();
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error(`Child exited before ${token}: ${errors}`));
        return;
      }
      const inspect = () => {
        if (output.includes(token)) {
          child.stdout!.off("data", inspect);
          resolve();
        }
      };
      child.stdout!.on("data", inspect);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Child exited before ${token}: ${code}\n${errors}`)));
    });
  await waitFor("BOOTED\n");
  return {
    child,
    start: async (boundary: PublicationBoundary) => {
      child.send(boundary);
      await waitFor("READY\n");
      await appendFile(`${TEMP}/text-publication-child-tests.log`, `${boundary}: ${errors}`);
    },
  };
}

async function pausedChild(options: PublishCompletedHostOptions, boundary: PublicationBoundary): Promise<ChildProcess> {
  const prepared = await preparedChild(options);
  await prepared.start(boundary);
  return prepared.child;
}

describe("incremental completed host publication", () => {
  async function forbidReads(path: string) {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockClear();
    vi.mocked(open).mockImplementation(async (...args) => {
      if (String(args[0]) === path) throw new Error("Unrelated document opened");
      return actual.open(...args);
    });
  }

  describe.each(["new host", "replacement", "no-op"])("prior-body isolation: %s", (operation) => {
    let fixture: Awaited<ReturnType<typeof setup>>;
    const old = complete("other.ubc.ca");
    beforeEach(async () => {
      fixture = await setup();
      await publishCompletedHost({ ...fixture.options, completed: old });
      if (operation !== "new host") await publishCompletedHost(fixture.options);
    });
    it("never opens prior document bodies through publication and cleanup", async () => {
      const oldDirectory = join(fixture.options.repositoryRoot, old.host.document_root!);
      const oldFile = join(oldDirectory, documentFilename(old.documents[0]!.id));
      const before = await tree(oldDirectory, true);
      const wholeBefore = await tree(fixture.options.repositoryRoot, true);
      await forbidReads(oldFile);
      const completed =
        operation === "replacement" ? complete("example.ubc.ca", "Replacement prose.\n") : fixture.options.completed;
      const options = { ...fixture.options, completed, incremental: true };
      const verifyInputs = vi.fn(async () => {});
      expect(await publishCompletedHost({ ...options, verifyInputs })).toEqual({
        changed: operation !== "no-op",
        hosts: [completed.host, old.host],
      });
      expect(parseDocument(await readFile(fixture.file))).toEqual(completed.documents[0]);
      if (operation === "no-op") expect(await tree(options.repositoryRoot, true)).toEqual(wholeBefore);
      expect(await tree(oldDirectory, true)).toEqual(before);
      expect(JSON.parse(await readFile(join(options.repositoryRoot, "data/official-hosts.json"), "utf8"))).toEqual([
        completed.host,
        old.host,
      ]);
      expect(verifyInputs).toHaveBeenCalledTimes(1);
      expect(vi.mocked(open).mock.calls.some(([path]) => String(path) === oldFile)).toBe(false);
      expect(vi.mocked(open).mock.calls.some(([path]) => String(path) === fixture.file)).toBe(true);
      await cleanWorkspace(fixture.workspace);
    });
  });

  describe("validator hostname subsets", () => {
    let fixture: Awaited<ReturnType<typeof setup>>;
    const other = complete("other.ubc.ca");
    beforeEach(async () => {
      fixture = await setup();
      await publishCompletedHost(fixture.options);
      await publishCompletedHost({ ...fixture.options, completed: other });
    });
    it.each([{ hostnames: [] }, { hostnames: ["example.ubc.ca"] }, { hostnames: ["example.ubc.ca", "other.ubc.ca"] }])(
      "returns the complete index while reading only $hostnames",
      async ({ hostnames }) => {
        vi.mocked(open).mockClear();
        expect(
          await validatePublishedHosts({ ...fixture.options, documentHostnames: Object.freeze(hostnames) }),
        ).toEqual([fixture.options.completed.host, other.host]);
        for (const completed of [fixture.options.completed, other]) {
          const file = join(
            fixture.options.repositoryRoot,
            completed.host.document_root!,
            documentFilename(completed.documents[0]!.id),
          );
          expect(vi.mocked(open).mock.calls.some(([path]) => String(path) === file)).toBe(
            hostnames.includes(completed.host.hostname),
          );
        }
      },
    );
    it.each(
      [["unknown.ubc.ca"], ["EXAMPLE.ubc.ca"], ["example.ubc.ca", "example.ubc.ca"]].map((hostnames) => ({
        hostnames,
      })),
    )("rejects invalid document hostnames $hostnames", async ({ hostnames }) => {
      await expect(validatePublishedHosts({ ...fixture.options, documentHostnames: hostnames })).rejects.toThrow();
    });
  });

  describe("strict auditing", () => {
    let fixture: Awaited<ReturnType<typeof setup>>;
    beforeEach(async () => {
      fixture = await setup();
      await publishCompletedHost(fixture.options);
      await appendFile(fixture.file, "tampered body");
    });
    it.each([undefined, false, true])(
      "keeps unrelated body auditing explicit with incremental=%s",
      async (incremental) => {
        const before = await tree(fixture.options.repositoryRoot, true);
        const options = {
          ...fixture.options,
          completed: complete("other.ubc.ca"),
          ...(incremental === undefined ? {} : { incremental }),
        };
        if (incremental) expect((await publishCompletedHost(options)).changed).toBe(true);
        else {
          await expect(publishCompletedHost(options)).rejects.toThrow(/digest mismatch/);
          expect(await tree(options.repositoryRoot, true)).toEqual(before);
        }
        await expect(validatePublishedHosts(fixture.options)).rejects.toThrow(/digest mismatch/);
      },
    );
  });

  it.each(["index encoding", "other metadata", "other count", "directory census", "target bytes", "target artifact"])(
    "rejects corrupt %s without mutation",
    async (kind) => {
      const fixture = await setup();
      await publishCompletedHost(fixture.options);
      await publishCompletedHost({ ...fixture.options, completed: complete("other.ubc.ca") });
      const root = fixture.options.repositoryRoot;
      const list = join(root, "data/official-hosts.json");
      if (kind === "index encoding") await appendFile(list, " ");
      if (kind === "other metadata" || kind === "other count") {
        const hosts = JSON.parse(await readFile(list, "utf8"));
        if (kind === "other metadata") hosts[1].document_root = "data/documents/example.ubc.ca";
        else hosts[1].document_count = 2;
        await writeFile(list, `${JSON.stringify(hosts, null, 2)}\n`);
      }
      if (kind === "directory census") await mkdir(join(root, "data/documents/unknown.ubc.ca"));
      if (kind === "target bytes") await appendFile(fixture.file, "tampered");
      if (kind === "target artifact")
        await writeFile(join(root, fixture.options.completed.host.document_root!, "unknown.txt"), "keep");
      const before = await tree(root, true);
      await expect(publishCompletedHost({ ...fixture.options, incremental: true })).rejects.toThrow();
      expect(await tree(root, true)).toEqual(before);
      await cleanWorkspace(fixture.workspace);
    },
  );

  it.each(["empty", "digest", "off-host", "duplicate"])("validates new %s documents", async (kind) => {
    const fixture = await setup();
    const completed = fixture.options.completed;
    if (kind === "empty") completed.documents = [];
    if (kind === "digest") completed.documents[0]!.body_sha256 = sha256("wrong");
    if (kind === "off-host") completed.documents[0]!.hostname = "other.ubc.ca";
    if (kind === "duplicate") {
      completed.documents = [...completed.documents, ...completed.documents];
      completed.host.document_count = 2;
    }
    await expect(publishCompletedHost({ ...fixture.options, incremental: true })).rejects.toThrow();
    expect(await readdir(fixture.options.repositoryRoot)).toEqual([]);
  });

  it.each(["target", "index"])("receipts reject valid but unowned %s bytes before atomic commit", async (kind) => {
    const fixture = await setup();
    await publishCompletedHost({ ...fixture.options, completed: complete("other.ubc.ca") });
    const path = kind === "target" ? fixture.file : join(fixture.options.repositoryRoot, "data/official-hosts.json");
    let unowned: Buffer;
    await expect(
      publishCompletedHost({
        ...fixture.options,
        incremental: true,
        testHook: async (boundary) => {
          if (boundary !== "commit-prepared") return;
          if (kind === "target")
            unowned = formatDocument(complete("example.ubc.ca", "Unexpected valid prose").documents[0]!);
          else {
            const hosts = JSON.parse(await readFile(path, "utf8"));
            hosts[1].title = "Unexpected other-host metadata";
            unowned = Buffer.from(`${JSON.stringify(hosts, null, 2)}\n`);
          }
          await writeFile(path, unowned);
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await readFile(path)).toEqual(unowned!);
    expect(await readdir(fixture.workspace)).not.toContain("committed.json");
    expect(await readdir(fixture.workspace)).toContain("journal.json");
  });

  it("awaits the input guard and preserves unknown external artifacts", async () => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const before = await tree(fixture.options.repositoryRoot, true);
    const options = { ...fixture.options, incremental: true, completed: complete("example.ubc.ca", "Changed") };
    await expect(
      publishCompletedHost({
        ...options,
        verifyInputs: async () => {
          throw new Error("Input guard");
        },
      }),
    ).rejects.toThrow("Input guard");
    expect(await tree(options.repositoryRoot, true)).toEqual(before);
    await cleanWorkspace(fixture.workspace);
    const unknown = join(fixture.workspace, "transaction/unknown.txt");
    await expect(
      publishCompletedHost({
        ...options,
        testHook: async (boundary) => {
          if (boundary === "prepared") await writeFile(unknown, "unowned bytes");
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await readFile(unknown, "utf8")).toBe("unowned bytes");
    expect(await tree(options.repositoryRoot, true)).toEqual(before);
  });

  describe("interrupted target recovery", () => {
    let fixture: Awaited<ReturnType<typeof setup>>;
    let prepared: Awaited<ReturnType<typeof preparedChild>>;
    const old = complete("other.ubc.ca");
    const changed = complete("example.ubc.ca", "Recovered replacement");
    beforeEach(async () => {
      fixture = await setup();
      await publishCompletedHost(fixture.options);
      await publishCompletedHost({ ...fixture.options, completed: old });
    });
    describe.each(["new-list-installed", "committed"] as const)("killed at %s", (boundary) => {
      beforeEach(async () => {
        prepared = await preparedChild({ ...fixture.options, completed: changed, incremental: true });
      });
      it("recovers the target without old-body reads", async () => {
        const oldDirectory = join(fixture.options.repositoryRoot, old.host.document_root!);
        const before = await tree(fixture.options.repositoryRoot, true);
        const otherBefore = await tree(oldDirectory, true);
        await prepared.start(boundary);
        const child = prepared.child;
        child.kill("SIGKILL");
        await exited(child);
        children.delete(child);
        await forbidReads(join(oldDirectory, documentFilename(old.documents[0]!.id)));
        await expect(
          publishCompletedHost({
            ...fixture.options,
            completed: changed,
            incremental: true,
            verifyInputs: async () => {
              throw new Error("Stop after recovery");
            },
          }),
        ).rejects.toThrow("Stop after recovery");
        if (boundary === "committed")
          expect(await readFile(fixture.file)).toEqual(formatDocument(changed.documents[0]!));
        else expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
        expect(await tree(oldDirectory, true)).toEqual(otherBefore);
        await cleanWorkspace(fixture.workspace);
      });
    });
  });
});

describe("completed host publication", () => {
  it.each([false, true])(
    "publishes one exact Markdown file and minimal index without repeat mutation (PDF: %s)",
    async (pdf) => {
      const fixture = await setup();
      if (pdf) {
        fixture.options.completed = complete(
          "example.ubc.ca",
          "## Page 1\n\n```text\nSource paper text.\n```\n",
          "/guide.pdf",
        );
        fixture.options.completed.documents[0]!.extraction = {
          format: "pdf",
          source_bytes_sha256: sha256("private PDF bytes"),
          source_bytes: 1234,
          pages: 1,
          profile_sha256: sha256("native profile"),
        };
        fixture.file = join(
          fixture.options.repositoryRoot,
          fixture.options.completed.host.document_root!,
          documentFilename(fixture.options.completed.documents[0]!.id),
        );
      }
      const before = structuredClone(fixture.options.completed);
      const verifyInputs = vi.fn(async () => {});
      const result = await publishCompletedHost({ ...fixture.options, verifyInputs });
      expect(result).toEqual({ changed: true, hosts: [fixture.options.completed.host] });
      expect(await readFile(fixture.file)).toEqual(formatDocument(before.documents[0]!));
      expect(parseDocument(await readFile(fixture.file)).content_markdown).toBe(before.documents[0]!.content_markdown);
      expect((await readdir(join(fixture.options.repositoryRoot, "data"))).sort()).toEqual([
        "documents",
        "official-hosts.json",
      ]);
      expect(await readdir(join(fixture.options.repositoryRoot, before.host.document_root!))).toEqual([
        documentFilename(before.documents[0]!.id),
      ]);
      expect(fixture.options.completed).toEqual(before);
      const published = await tree(fixture.options.repositoryRoot, true);
      expect((await publishCompletedHost({ ...fixture.options, verifyInputs })).changed).toBe(false);
      expect(await tree(fixture.options.repositoryRoot, true)).toEqual(published);
      expect(verifyInputs).toHaveBeenCalledTimes(2);
      await cleanWorkspace(fixture.workspace);
    },
  );

  it("preserves upstream data, other hosts and existing modes while replacing the complete host directory", async () => {
    const fixture = await setup();
    const upstream = join(fixture.options.repositoryRoot, "data/prose");
    await mkdir(upstream, { recursive: true });
    await writeFile(join(upstream, "upstream.json"), "unchanged\u0000upstream");
    await publishCompletedHost({ ...fixture.options, completed: complete("other.ubc.ca") });
    await publishCompletedHost(fixture.options);
    const root = fixture.options.repositoryRoot;
    const hostDirectory = join(root, fixture.options.completed.host.document_root!);
    const list = join(root, "data/official-hosts.json");
    await chmod(join(root, "data"), 0o751);
    await chmod(join(root, "data/documents"), 0o750);
    await chmod(hostDirectory, 0o750);
    await chmod(fixture.file, 0o640);
    await chmod(list, 0o640);
    const otherBefore = await tree(join(root, "data/documents/other.ubc.ca"), true);
    const upstreamBefore = await tree(upstream, true);
    const changed = complete("example.ubc.ca", "Changed text without added heading");
    const added = complete("example.ubc.ca", "Second document", "/second").documents[0]!;
    const replacement = {
      ...changed,
      host: { ...changed.host, document_count: 2 },
      documents: [...changed.documents, added],
    };
    expect(
      (await publishCompletedHost({ ...fixture.options, completed: replacement })).hosts.map((host) => host.hostname),
    ).toEqual(["example.ubc.ca", "other.ubc.ca"]);
    expect((await lstat(fixture.file)).mode & 0o7777).toBe(0o640);
    expect((await lstat(hostDirectory)).mode & 0o7777).toBe(0o750);
    expect((await lstat(list)).mode & 0o7777).toBe(0o640);
    expect((await lstat(join(root, "data"))).mode & 0o7777).toBe(0o751);
    expect((await lstat(join(root, "data/documents"))).mode & 0o7777).toBe(0o750);
    expect(await tree(join(root, "data/documents/other.ubc.ca"), true)).toEqual(otherBefore);
    expect(await tree(upstream, true)).toEqual(upstreamBefore);
    await publishCompletedHost({ ...fixture.options, completed: changed });
    expect(await readdir(hostDirectory)).toEqual([documentFilename(changed.documents[0]!.id)]);
    await cleanWorkspace(fixture.workspace);
  });

  it("preserves read-only files and fails closed for a nonwritable host directory", async () => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const directory = join(fixture.options.repositoryRoot, fixture.options.completed.host.document_root!);
    const list = join(fixture.options.repositoryRoot, "data/official-hosts.json");
    await chmod(fixture.file, 0o444);
    await chmod(list, 0o444);
    const changed = complete("example.ubc.ca", "Read-only replacement");
    await publishCompletedHost({ ...fixture.options, completed: changed });
    expect((await lstat(fixture.file)).mode & 0o7777).toBe(0o444);
    expect((await lstat(list)).mode & 0o7777).toBe(0o444);
    await chmod(directory, 0o555);
    try {
      const before = await tree(fixture.options.repositoryRoot, true);
      expect((await publishCompletedHost({ ...fixture.options, completed: changed })).changed).toBe(false);
      await expect(publishCompletedHost(fixture.options)).rejects.toThrow(/directory mode/);
      expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
      await cleanWorkspace(fixture.workspace);
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it.each(["incomplete", "empty", "count", "host", "duplicate", "producer", "input", "runtime override"])(
    "rejects %s without repository mutation",
    async (problem) => {
      const fixture = await setup();
      const options = { ...fixture.options, completed: structuredClone(fixture.options.completed) };
      if (problem === "incomplete") (options.completed as { complete: boolean }).complete = false;
      if (problem === "empty") options.completed.documents = [];
      if (problem === "count") options.completed.host.document_count = 3;
      if (problem === "host") options.completed.host.hostname = "other.ubc.ca";
      if (["duplicate", "producer", "input"].includes(problem)) {
        const second =
          problem === "duplicate"
            ? options.completed.documents[0]!
            : complete("example.ubc.ca", "second", "/second").documents[0]!;
        if (problem === "producer") second.producer.inputs_sha256 = sha256("different producer");
        if (problem === "input") second.input_sha256 = sha256("different inputs");
        options.completed.documents = [...options.completed.documents, second];
        options.completed.host.document_count = 2;
      }
      if (problem === "runtime override") Object.assign(options, { proseOverride: "unsafe" });
      const before = await tree(options.repositoryRoot, true);
      await expect(publishCompletedHost(options)).rejects.toThrow();
      expect(await tree(options.repositoryRoot, true)).toEqual(before);
    },
  );

  it("awaits the frozen-input/code guard after preparation and before creating repository paths", async () => {
    const fixture = await setup();
    const before = await tree(fixture.options.repositoryRoot, true);
    let prepared = false;
    await expect(
      publishCompletedHost({
        ...fixture.options,
        testHook: async (boundary) => {
          if (boundary === "prepared") prepared = true;
        },
        verifyInputs: async () => {
          await Promise.resolve();
          expect(prepared).toBe(true);
          expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
          throw new Error("Frozen input/code guard failure");
        },
      }),
    ).rejects.toThrow(/Frozen input/);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    await cleanWorkspace(fixture.workspace);
  });

  it.each(BOUNDARIES.flatMap((boundary) => [false, true].map((existing) => ({ boundary, existing }))))(
    "recovers injected $boundary with existing output=$existing",
    async ({ boundary, existing }) => {
      const fixture = await setup();
      if (existing) await publishCompletedHost(fixture.options);
      const before = await tree(fixture.options.repositoryRoot, true);
      const changed = complete("example.ubc.ca", "Replacement original prose.\n");
      await expect(
        publishCompletedHost({
          ...fixture.options,
          completed: changed,
          testHook: (value) => {
            if (value === boundary) throw new Error(`Injected ${boundary}`);
          },
        }),
      ).rejects.toThrow(`Injected ${boundary}`);
      if (AFTER_COMMIT.has(boundary)) {
        expect(await readFile(fixture.file)).toEqual(formatDocument(changed.documents[0]!));
        expect(await validatePublishedHosts(fixture.options)).toEqual([changed.host]);
      } else expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
      await cleanWorkspace(fixture.workspace);
    },
  );

  describe("process interruption recovery", () => {
    let fixture: Awaited<ReturnType<typeof setup>>;
    let before: unknown[];
    let prepared: Awaited<ReturnType<typeof preparedChild>>;
    const changed = complete("example.ubc.ca", "Replacement from crashed worker.\n");
    beforeEach(async () => {
      fixture = await setup();
      await publishCompletedHost(fixture.options);
      before = await tree(fixture.options.repositoryRoot, true);
      prepared = await preparedChild({ ...fixture.options, completed: changed });
    });
    it.each(BOUNDARIES)("recovers SIGKILL at %s using process-released locks", async (boundary) => {
      await prepared.start(boundary);
      const child = prepared.child;
      child.kill("SIGKILL");
      await exited(child);
      children.delete(child);
      await expect(
        publishCompletedHost({
          ...fixture.options,
          completed: changed,
          verifyInputs: async () => {
            throw new Error("Stop after recovery");
          },
        }),
      ).rejects.toThrow(/Stop after recovery/);
      if (AFTER_COMMIT.has(boundary))
        expect(await readFile(fixture.file)).toEqual(formatDocument(changed.documents[0]!));
      else expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
      await cleanWorkspace(fixture.workspace);
    });
  });

  it("fails fast on a live SQLite writer and permits publication after that process dies", async () => {
    const fixture = await setup();
    const child = await pausedChild(fixture.options, "locked");
    const before = await tree(fixture.options.repositoryRoot, true);
    await expect(publishCompletedHost(fixture.options)).rejects.toThrow(/lock is held/);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    child.kill("SIGKILL");
    await exited(child);
    children.delete(child);
    expect((await publishCompletedHost(fixture.options)).changed).toBe(true);
    await cleanWorkspace(fixture.workspace);
  });

  it("fails closed on EXDEV instead of copying or installing partial output", async () => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const before = await tree(fixture.options.repositoryRoot, true);
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed: complete("example.ubc.ca", "Changed body"),
        testHook: (boundary) => {
          if (boundary === "inputs-verified")
            vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("EXDEV injected"), { code: "EXDEV" }));
        },
      }),
    ).rejects.toThrow(/EXDEV/);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    await cleanWorkspace(fixture.workspace);
  });

  it.each(["outside", "overlap", "traversal", "symlink"])("rejects an %s external root", async (kind) => {
    const fixture = await setup();
    let externalRoot =
      kind === "outside"
        ? "/tmp/forbidden-publication"
        : kind === "overlap"
          ? join(fixture.options.repositoryRoot, "external")
          : `${fixture.options.externalRoot}/../alias`;
    if (kind === "symlink") {
      await mkdir(fixture.options.externalRoot);
      externalRoot = join(fixture.root, "alias");
      await symlink(fixture.options.externalRoot, externalRoot);
    }
    const before = await tree(fixture.options.repositoryRoot, true);
    await expect(publishCompletedHost({ ...fixture.options, externalRoot })).rejects.toThrow();
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
  });

  it.each(["unknown lock", "journal traversal", "workspace symlink"])(
    "rejects %s without modifying it",
    async (kind) => {
      const fixture = await setup();
      await mkdir(fixture.options.externalRoot);
      if (kind === "workspace symlink") await symlink(fixture.options.repositoryRoot, fixture.workspace);
      else {
        await mkdir(fixture.workspace);
        if (kind === "unknown lock") await writeFile(join(fixture.workspace, "lock.sqlite"), "not owned SQLite");
        else {
          await publishCompletedHost({ ...fixture.options, testHook: undefined });
          await writeFile(
            join(fixture.workspace, "journal.json"),
            JSON.stringify({ hostname: "../../outside", repository_root: fixture.options.repositoryRoot }),
          );
        }
      }
      const before = await tree(fixture.options.repositoryRoot, true);
      const external = await tree(fixture.options.externalRoot);
      await expect(publishCompletedHost(fixture.options)).rejects.toThrow();
      expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
      expect(await tree(fixture.options.externalRoot)).toEqual(external);
    },
  );

  it("rejects unknown repository artifacts and leaves their exact bytes untouched", async () => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const unknown = join(fixture.options.repositoryRoot, fixture.options.completed.host.document_root!, "unknown.json");
    await writeFile(unknown, "user owned data");
    const before = await tree(fixture.options.repositoryRoot, true);
    await expect(
      publishCompletedHost({ ...fixture.options, completed: complete("example.ubc.ca", "Changed") }),
    ).rejects.toThrow();
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
  });

  it("refuses destructive cleanup when an external artifact is unrecognized", async () => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const changed = complete("example.ubc.ca", "Committed original text");
    const unknown = join(fixture.workspace, "transaction/unknown.txt");
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed: changed,
        testHook: async (boundary) => {
          if (boundary === "committed") {
            await writeFile(unknown, "do not delete");
            throw new Error("Injected unknown artifact");
          }
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await readFile(unknown, "utf8")).toBe("do not delete");
    expect(await readFile(fixture.file)).toEqual(formatDocument(changed.documents[0]!));
    const retained = await tree(fixture.workspace);
    await expect(publishCompletedHost({ ...fixture.options, completed: changed })).rejects.toThrow(/Unrecognized/);
    expect(await tree(fixture.workspace)).toEqual(retained);
  });

  it.each(["changed bytes", "symlink"])("preserves rather than deleting a %s stage", async (kind) => {
    const fixture = await setup();
    const before = await tree(fixture.options.repositoryRoot, true);
    const path = join(
      fixture.workspace,
      "transaction/new-host",
      documentFilename(fixture.options.completed.documents[0]!.id),
    );
    const target = join(fixture.root, "unowned-target");
    await writeFile(target, "untouched target");
    await expect(
      publishCompletedHost({
        ...fixture.options,
        testHook: async (boundary) => {
          if (boundary === "prepared") {
            if (kind === "symlink") {
              await rm(path);
              await symlink(target, path);
            } else await writeFile(path, "unrecognized bytes");
          }
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    expect(await readFile(target, "utf8")).toBe("untouched target");
    if (kind === "symlink") expect(await readlink(path)).toBe(target);
    else expect(await readFile(path, "utf8")).toBe("unrecognized bytes");
  });

  it("restores old output but retains a partially written uncommitted marker", async () => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const before = await tree(fixture.options.repositoryRoot, true);
    const marker = join(fixture.workspace, "commit-ready.json");
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed: complete("example.ubc.ca", "Changed body"),
        testHook: async (boundary) => {
          if (boundary === "commit-prepared") await writeFile(marker, "partial marker bytes");
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    expect(await readFile(marker, "utf8")).toBe("partial marker bytes");
  });

  describe("interrupted committed cleanup", () => {
    let fixture: Awaited<ReturnType<typeof setup>>;
    let changed: CompletedHost;
    beforeEach(async () => {
      fixture = await setup();
      const old = complete();
      const extra = complete("example.ubc.ca", "Second old document", "/second").documents[0]!;
      await publishCompletedHost({
        ...fixture.options,
        completed: { ...old, host: { ...old.host, document_count: 2 }, documents: [...old.documents, extra] },
      });
      changed = complete("example.ubc.ca", "Committed replacement");
      const child = await pausedChild({ ...fixture.options, completed: changed }, "before-cleanup");
      child.kill("SIGKILL");
      await exited(child);
      children.delete(child);
    });
    it.each(["partial backup cleanup", "commit marker alone"])("recovers interrupted %s", async (phase) => {
      if (phase === "partial backup cleanup") {
        const backup = join(fixture.workspace, "transaction/old-host");
        const names = (await readdir(backup)).sort();
        expect(names).toHaveLength(2);
        await rm(join(backup, names[0]!));
      } else {
        expect(await readFile(join(fixture.workspace, "committed.json"))).toEqual(
          await readFile(join(fixture.workspace, "journal.json")),
        );
        await rm(join(fixture.workspace, "transaction"), { recursive: true });
        await rm(join(fixture.workspace, "journal.json"));
      }
      expect((await publishCompletedHost({ ...fixture.options, completed: changed })).changed).toBe(false);
      expect(await readFile(fixture.file)).toEqual(formatDocument(changed.documents[0]!));
      await cleanWorkspace(fixture.workspace);
    });
  });

  it("preserves a modified owned backup rather than trusting its filename", async () => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const backup = join(
      fixture.workspace,
      "transaction/old-host",
      documentFilename(fixture.options.completed.documents[0]!.id),
    );
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed: complete("example.ubc.ca", "Changed body"),
        testHook: async (boundary) => {
          if (boundary === "new-host-installed") {
            await writeFile(backup, "unknown backup bytes");
            throw new Error("Injected backup corruption");
          }
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await readFile(backup, "utf8")).toBe("unknown backup bytes");
    expect(await readFile(fixture.file)).toEqual(
      formatDocument(complete("example.ubc.ca", "Changed body").documents[0]!),
    );
  });
});

function categorized(
  categories: readonly DocumentCategory[] = ["academics", "support"],
  hostname = "example.ubc.ca",
  body = "Category source prose.\n",
): CompletedHost {
  const base = complete(hostname);
  const { document_root: _, ...metadata } = base.host;
  const documents = categories.map((category, index) => ({
    ...complete(hostname, `${body}${index}\n`, index ? `/page-${index}` : "/page").documents[0]!,
    category,
    routing: { rule_id: "synthetic-category", policy_sha256: sha256("synthetic policy") },
  }));
  return {
    complete: true,
    host: {
      ...metadata,
      document_count: documents.length,
      document_roots: [...new Set(categories)].sort().map((category) => ({
        category,
        path: `data/documents/${category}/${hostname}`,
        document_count: categories.filter((value) => value === category).length,
      })),
    },
    documents,
  };
}

function legacyOf(completed: CompletedHost): CompletedHost {
  const { document_roots: _, ...metadata } = completed.host;
  return {
    complete: true,
    host: { ...metadata, document_root: `data/documents/${metadata.hostname}` },
    documents: completed.documents.map(({ category: _, routing: __, ...document }) => document),
  };
}

function withdrawal(options: PublishCompletedHostOptions): WithdrawPublishedHostOptions {
  const { completed, ...common } = options;
  return { ...common, hostname: completed.host.hostname };
}

async function assertDocuments(repositoryRoot: string, completed: CompletedHost): Promise<void> {
  for (const root of hostDocumentRoots(completed.host)) {
    const docs = completed.documents.filter((doc) => doc.category === root.category);
    expect((await readdir(join(repositoryRoot, root.path))).sort()).toEqual(
      docs.map((doc) => documentFilename(doc.id)).sort(),
    );
    for (const doc of docs) {
      const bytes = await readFile(join(repositoryRoot, root.path, documentFilename(doc.id)));
      expect(bytes).toEqual(formatDocument(doc));
      expect(parseDocument(bytes, { hostname: doc.hostname, category: root.category })).toEqual(doc);
    }
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  child.kill("SIGKILL");
  await exited(child);
  children.delete(child);
}

async function stagedJournal(workspace: string) {
  return JSON.parse(await readFile(join(workspace, "journal.json"), "utf8")) as {
    format_version: number;
    parents: Array<{ path: string; mode: number | null }>;
    directories: Array<{ path: string; old: unknown; new: unknown }>;
  };
}

describe("category-first host publication", () => {
  it("migrates the indexed legacy directory into every category with exact bytes and preserved modes", async () => {
    const fixture = await setup();
    const completed = categorized(DOCUMENT_CATEGORIES);
    const legacy = legacyOf(completed);
    await publishCompletedHost({ ...fixture.options, completed: legacy });
    await chmod(join(fixture.options.repositoryRoot, legacy.host.document_root!), 0o750);
    await chmod(fixture.file, 0o440);
    const before = structuredClone(completed);
    expect(await publishCompletedHost({ ...fixture.options, completed })).toEqual({
      changed: true,
      hosts: [completed.host],
    });
    await expect(lstat(join(fixture.options.repositoryRoot, legacy.host.document_root!))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertDocuments(fixture.options.repositoryRoot, completed);
    for (const root of hostDocumentRoots(completed.host))
      expect((await lstat(join(fixture.options.repositoryRoot, root.path))).mode & 0o7777).toBe(0o750);
    const first = completed.documents[0]!;
    expect(
      (
        await lstat(
          join(
            fixture.options.repositoryRoot,
            `data/documents/${first.category}/${first.hostname}`,
            documentFilename(first.id),
          ),
        )
      ).mode & 0o7777,
    ).toBe(0o440);
    const publicBefore = await tree(fixture.options.repositoryRoot, true);
    expect((await publishCompletedHost({ ...fixture.options, completed })).changed).toBe(false);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(publicBefore);
    expect(completed).toEqual(before);
    expect(await validatePublishedHosts({ ...fixture.options, requireCategories: true })).toEqual([completed.host]);
    await cleanWorkspace(fixture.workspace);
  });

  it("replaces only target-host roots while retaining other hosts in shared category parents", async () => {
    const fixture = await setup();
    const other = categorized(["academics", "support"], "other.ubc.ca");
    const original = categorized();
    await publishCompletedHost({ ...fixture.options, completed: other });
    await publishCompletedHost({ ...fixture.options, completed: original });
    const root = fixture.options.repositoryRoot;
    const others = await Promise.all(hostDocumentRoots(other.host).map((entry) => tree(join(root, entry.path), true)));
    await chmod(join(root, "data/documents/academics"), 0o750);
    const parentInode = (await lstat(join(root, "data/documents/academics"))).ino;
    const changed = categorized(["academics", "news", "news"]);
    expect((await publishCompletedHost({ ...fixture.options, completed: changed })).changed).toBe(true);
    await assertDocuments(root, changed);
    await expect(lstat(join(root, "data/documents/support/example.ubc.ca"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(root, "data/documents/academics"))).ino).toBe(parentInode);
    expect((await lstat(join(root, "data/documents/academics"))).mode & 0o7777).toBe(0o750);
    expect(await Promise.all(hostDocumentRoots(other.host).map((entry) => tree(join(root, entry.path), true)))).toEqual(
      others,
    );
    expect(await validatePublishedHosts(fixture.options)).toEqual([changed.host, other.host]);
    await cleanWorkspace(fixture.workspace);
  });

  it.each(["missing category", "wrong category", "root count", "mixed roots", "path traversal", "unknown category"])(
    "rejects %s before public mutation",
    async (kind) => {
      const fixture = await setup();
      const completed = categorized();
      if (kind === "missing category") {
        delete completed.documents[0]!.category;
        delete completed.documents[0]!.routing;
      }
      if (kind === "wrong category") completed.documents[0]!.category = "news";
      if (kind === "root count") completed.host.document_roots![0]!.document_count++;
      if (kind === "mixed roots") completed.host.document_root = "data/documents/example.ubc.ca";
      if (kind === "path traversal")
        completed.host.document_roots![0]!.path = "data/documents/academics/../example.ubc.ca";
      if (kind === "unknown category") (completed.host.document_roots![0] as { category: string }).category = "unknown";
      const before = await tree(fixture.options.repositoryRoot, true);
      await expect(publishCompletedHost({ ...fixture.options, completed })).rejects.toThrow();
      expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    },
  );

  it.each(
    BOUNDARIES.flatMap((boundary) => ["new", "migration", "replacement"].map((operation) => ({ boundary, operation }))),
  )("rolls back all roots at $boundary for $operation", async ({ boundary, operation }) => {
    const fixture = await setup();
    const completed = categorized(["academics", "news", "support"]);
    if (operation !== "new")
      await publishCompletedHost({
        ...fixture.options,
        completed: operation === "migration" ? legacyOf(completed) : categorized(),
      });
    const before = await tree(fixture.options.repositoryRoot, true);
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed,
        testHook: (value) => {
          if (value === boundary) throw new Error(`Injected ${boundary}`);
        },
      }),
    ).rejects.toThrow(`Injected ${boundary}`);
    if (AFTER_COMMIT.has(boundary)) {
      await assertDocuments(fixture.options.repositoryRoot, completed);
      expect(await validatePublishedHosts(fixture.options)).toEqual([completed.host]);
    } else expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    await cleanWorkspace(fixture.workspace);
  });

  it.each([
    { boundary: "old-host-moved", occurrence: 2 },
    { boundary: "new-host-installed", occurrence: 2 },
    { boundary: "new-list-installed", occurrence: 1 },
    { boundary: "committed", occurrence: 1 },
  ] as const)("recovers SIGKILL at $boundary occurrence $occurrence", async ({ boundary, occurrence }) => {
    const fixture = await setup();
    const old = categorized();
    await publishCompletedHost({ ...fixture.options, completed: old });
    const before = await tree(fixture.options.repositoryRoot, true);
    const completed = categorized(["academics", "news", "support"], "example.ubc.ca", "Replacement text\n");
    const prepared = await preparedChild({ ...fixture.options, completed }, occurrence);
    await prepared.start(boundary);
    expect((await stagedJournal(fixture.workspace)).format_version).toBe(2);
    await stopChild(prepared.child);
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed,
        verifyInputs: async () => {
          throw new Error("Stop after recovery");
        },
      }),
    ).rejects.toThrow("Stop after recovery");
    if (AFTER_COMMIT.has(boundary)) await assertDocuments(fixture.options.repositoryRoot, completed);
    else expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    await cleanWorkspace(fixture.workspace);
  });

  it.each(["partial backups", "marker alone"])("finishes multi-directory committed cleanup with %s", async (phase) => {
    const fixture = await setup();
    await publishCompletedHost({ ...fixture.options, completed: categorized(["academics", "support", "support"]) });
    const completed = categorized(["news", "research"]);
    const prepared = await preparedChild({ ...fixture.options, completed });
    await prepared.start("before-cleanup");
    await stopChild(prepared.child);
    if (phase === "marker alone") {
      await rm(join(fixture.workspace, "journal.json"));
      await rm(join(fixture.workspace, "transaction"), { recursive: true });
    } else {
      const journal = await stagedJournal(fixture.workspace);
      for (const [index, entry] of journal.directories.entries()) {
        if (!entry.old) continue;
        const backup = join(fixture.workspace, `transaction/old-host-${index}`);
        const files = await readdir(backup);
        await rm(join(backup, files[0]!));
      }
    }
    expect((await publishCompletedHost({ ...fixture.options, completed })).changed).toBe(false);
    await assertDocuments(fixture.options.repositoryRoot, completed);
    await cleanWorkspace(fixture.workspace);
  });

  it.each([
    "last public bytes",
    "last backup bytes",
    "last public symlink",
    "last public hardlink",
    "index",
    "parent mode",
  ])("validates every receipt before rollback when %s changes", async (kind) => {
    const fixture = await setup();
    const old = categorized();
    await publishCompletedHost({ ...fixture.options, completed: old });
    const completed = categorized(["academics", "support"], "example.ubc.ca", "New text\n");
    let publicAfter: unknown[] = [];
    let workspaceAfter: unknown[] = [];
    const outsider = join(fixture.root, "unowned.txt");
    await writeFile(outsider, "unowned");
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed,
        testHook: async (boundary) => {
          if (boundary !== "new-list-installed") return;
          const journal = await stagedJournal(fixture.workspace);
          const index = journal.directories.length - 1;
          const directory = journal.directories[index]!;
          const path =
            kind === "last backup bytes"
              ? join(fixture.workspace, `transaction/old-host-${index}`, documentFilename(old.documents[1]!.id))
              : join(fixture.options.repositoryRoot, directory.path, documentFilename(completed.documents[1]!.id));
          if (kind === "parent mode")
            await chmod(join(fixture.options.repositoryRoot, "data/documents/support"), 0o750);
          else if (kind === "index")
            await appendFile(join(fixture.options.repositoryRoot, "data/official-hosts.json"), " ");
          else if (kind === "last public symlink" || kind === "last public hardlink") {
            await rm(path);
            if (kind === "last public symlink") await symlink(outsider, path);
            else await link(outsider, path);
          } else await writeFile(path, "unowned bytes");
          publicAfter = await tree(fixture.options.repositoryRoot, true);
          workspaceAfter = await tree(fixture.workspace);
          throw new Error("Injected unowned bytes");
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(publicAfter);
    expect(await tree(fixture.workspace)).toEqual(workspaceAfter);
    expect(await readFile(outsider, "utf8")).toBe("unowned");
  });

  it.each(["symlink parent", "hardlinked old file", "unindexed destination", "unknown flat artifact"])(
    "refuses %s without deleting any bytes",
    async (kind) => {
      const fixture = await setup();
      await publishCompletedHost(fixture.options);
      const completed = categorized();
      const root = fixture.options.repositoryRoot;
      if (kind === "symlink parent") {
        const external = join(fixture.root, "outside-category");
        await mkdir(external);
        await symlink(external, join(root, "data/documents/academics"));
      }
      if (kind === "hardlinked old file") await link(fixture.file, join(fixture.root, "private-alias"));
      if (kind === "unindexed destination") {
        await mkdir(join(root, "data/documents/academics/example.ubc.ca"), { recursive: true });
        await writeFile(
          join(root, "data/documents/academics/example.ubc.ca", documentFilename(completed.documents[0]!.id)),
          formatDocument(completed.documents[0]!),
        );
      }
      if (kind === "unknown flat artifact")
        await writeFile(join(root, "data/documents/example.ubc.ca/keep.txt"), "owned elsewhere");
      const before = await tree(root, true);
      await expect(publishCompletedHost({ ...fixture.options, completed })).rejects.toThrow();
      expect(await tree(root, true)).toEqual(before);
    },
  );

  it("does not commit a reappearing legacy root or delete its unowned bytes", async () => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const completed = categorized();
    const legacy = join(fixture.options.repositoryRoot, "data/documents/example.ubc.ca");
    let before: unknown[] = [];
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed,
        testHook: async (boundary) => {
          if (boundary !== "commit-prepared") return;
          await mkdir(legacy);
          await writeFile(fixture.file, formatDocument(fixture.options.completed.documents[0]!));
          before = await tree(fixture.options.repositoryRoot, true);
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    expect(await readdir(fixture.workspace)).not.toContain("committed.json");
  });

  it("restores every root when a later rename fails with EXDEV", async () => {
    const fixture = await setup();
    const old = categorized();
    await publishCompletedHost({ ...fixture.options, completed: old });
    const before = await tree(fixture.options.repositoryRoot, true);
    const completed = categorized(["academics", "research", "support"]);
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed,
        testHook: (boundary) => {
          if (boundary === "new-host-installed")
            vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("EXDEV injected"), { code: "EXDEV" }));
        },
      }),
    ).rejects.toThrow("EXDEV");
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    await cleanWorkspace(fixture.workspace);
  });

  it("detects other-host valid-byte mutation without overwriting the changed other host", async () => {
    const fixture = await setup();
    const old = categorized();
    const other = categorized(["academics"], "other.ubc.ca");
    await publishCompletedHost({ ...fixture.options, completed: old });
    await publishCompletedHost({ ...fixture.options, completed: other });
    const oldTrees = await Promise.all(
      hostDocumentRoots(old.host).map((entry) => tree(join(fixture.options.repositoryRoot, entry.path), true)),
    );
    const otherFile = join(
      fixture.options.repositoryRoot,
      other.host.document_roots![0]!.path,
      documentFilename(other.documents[0]!.id),
    );
    const replacement = formatDocument(
      categorized(["academics"], "other.ubc.ca", "Unexpected but valid prose\n").documents[0]!,
    );
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed: categorized(["news", "support"]),
        testHook: async (boundary) => {
          if (boundary === "before-commit") await writeFile(otherFile, replacement);
        },
      }),
    ).rejects.toThrow(/public output changed/);
    expect(
      await Promise.all(
        hostDocumentRoots(old.host).map((entry) => tree(join(fixture.options.repositoryRoot, entry.path), true)),
      ),
    ).toEqual(oldTrees);
    expect(await readFile(otherFile)).toEqual(replacement);
    await cleanWorkspace(fixture.workspace);
  });

  it.each(["migration", "replacement", "withdrawal"])(
    "keeps incremental %s from opening other-host document bodies",
    async (operation) => {
      const fixture = await setup();
      const other = categorized(["academics", "support"], "other.ubc.ca");
      const completed = categorized();
      await publishCompletedHost({ ...fixture.options, completed: other });
      await publishCompletedHost({
        ...fixture.options,
        completed: operation === "migration" ? legacyOf(completed) : completed,
      });
      const paths = hostDocumentRoots(other.host).map((entry) => join(fixture.options.repositoryRoot, entry.path));
      const before = await Promise.all(paths.map((path) => tree(path, true)));
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(open).mockImplementation(async (...args) => {
        if (paths.some((path) => String(args[0]).startsWith(`${path}/`))) throw new Error("Other body opened");
        return actual.open(...args);
      });
      if (operation === "withdrawal")
        await withdrawPublishedHost({ ...withdrawal(fixture.options), incremental: true });
      else
        await publishCompletedHost({
          ...fixture.options,
          completed: categorized(["academics", "support"], "example.ubc.ca", "New body\n"),
          incremental: true,
        });
      expect(await Promise.all(paths.map((path) => tree(path, true)))).toEqual(before);
      await cleanWorkspace(fixture.workspace);
    },
  );
});

describe("publication journal compatibility", () => {
  it.each(["new-list-installed", "committed"] as const)(
    "recovers an unchanged v1 journal before category migration at %s",
    async (boundary) => {
      const fixture = await setup();
      await publishCompletedHost(fixture.options);
      const before = await tree(fixture.options.repositoryRoot, true);
      const legacy = complete("example.ubc.ca", "Legacy crash bytes\n");
      const prepared = await preparedChild({ ...fixture.options, completed: legacy });
      await prepared.start(boundary);
      await stopChild(prepared.child);
      const journal = JSON.parse(await readFile(join(fixture.workspace, "journal.json"), "utf8"));
      expect(Object.keys(journal)).toEqual([
        "format_version",
        "repository_root",
        "hostname",
        "data_mode",
        "documents_mode",
        "old_host",
        "new_host",
        "old_list",
        "new_list",
      ]);
      expect(journal.format_version).toBe(1);
      await expect(
        publishCompletedHost({
          ...fixture.options,
          completed: categorized(),
          verifyInputs: async () => {
            throw new Error("Stop after v1 recovery");
          },
        }),
      ).rejects.toThrow("Stop after v1 recovery");
      if (boundary === "committed") await assertDocuments(fixture.options.repositoryRoot, legacy);
      else expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
      await cleanWorkspace(fixture.workspace);
      const completed = categorized();
      expect((await publishCompletedHost({ ...fixture.options, completed })).changed).toBe(true);
      await assertDocuments(fixture.options.repositoryRoot, completed);
    },
  );

  it.each([
    "directory traversal",
    "other hostname",
    "duplicate root",
    "parent traversal",
    "extra parent",
    "missing receipt",
    "mixed layout",
    "unknown version",
  ])("retains invalid v2 journal with %s without mutating any public path", async (kind) => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const before = await tree(fixture.options.repositoryRoot, true);
    const completed = categorized();
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed,
        testHook: async (boundary) => {
          if (boundary !== "journal-written") return;
          const journal = await stagedJournal(fixture.workspace);
          if (kind === "directory traversal")
            journal.directories[0]!.path = "data/documents/academics/../example.ubc.ca";
          if (kind === "other hostname") journal.directories[0]!.path = "data/documents/academics/other.ubc.ca";
          if (kind === "duplicate root") journal.directories.push(journal.directories[0]!);
          if (kind === "parent traversal") journal.parents[0]!.path = "../outside";
          if (kind === "extra parent") journal.parents.push({ path: "data/unowned", mode: null });
          if (kind === "missing receipt") {
            journal.directories[0]!.old = null;
            journal.directories[0]!.new = null;
          }
          if (kind === "mixed layout")
            journal.directories[0]!.old = journal.directories.find((entry) => entry.old)!.old;
          if (kind === "unknown version") journal.format_version = 3;
          await writeFile(join(fixture.workspace, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
          throw new Error("Injected invalid journal");
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    const external = await tree(fixture.workspace);
    await expect(publishCompletedHost({ ...fixture.options, completed })).rejects.toThrow();
    expect(await tree(fixture.workspace)).toEqual(external);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
  });

  it("retains malformed v1 journals instead of treating their namespace as unowned cleanup", async () => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const before = await tree(fixture.options.repositoryRoot, true);
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed: complete("example.ubc.ca", "New bytes"),
        testHook: async (boundary) => {
          if (boundary !== "journal-written") return;
          const path = join(fixture.workspace, "journal.json");
          const journal = JSON.parse(await readFile(path, "utf8"));
          expect(journal.format_version).toBe(1);
          journal.old_host.files[0].name = "../../outside";
          await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`);
          throw new Error("Injected legacy journal corruption");
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    const external = await tree(fixture.workspace);
    await expect(publishCompletedHost({ ...fixture.options, completed: categorized() })).rejects.toThrow(
      /receipt filename/,
    );
    expect(await tree(fixture.workspace)).toEqual(external);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
  });
});

describe("explicit host withdrawal", () => {
  it.each([false, true])("removes only indexed owned roots and index entries (categorized: %s)", async (categories) => {
    const fixture = await setup();
    const completed = categories ? categorized() : fixture.options.completed;
    const other = categorized(["academics"], "other.ubc.ca");
    await publishCompletedHost({ ...fixture.options, completed });
    await publishCompletedHost({ ...fixture.options, completed: other });
    const privateArchive = join(fixture.root, "private-archive.md");
    await writeFile(privateArchive, formatDocument(completed.documents[0]!));
    const otherBefore = await tree(join(fixture.options.repositoryRoot, other.host.document_roots![0]!.path), true);
    const verifyInputs = vi.fn(async () => {
      expect(await readFile(privateArchive)).toEqual(formatDocument(completed.documents[0]!));
    });
    const options = { ...withdrawal(fixture.options), verifyInputs };
    expect(await withdrawPublishedHost(options)).toEqual({ changed: true, hosts: [other.host] });
    for (const entry of hostDocumentRoots(completed.host))
      await expect(lstat(join(fixture.options.repositoryRoot, entry.path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await tree(join(fixture.options.repositoryRoot, other.host.document_roots![0]!.path), true)).toEqual(
      otherBefore,
    );
    expect(await readFile(privateArchive)).toEqual(formatDocument(completed.documents[0]!));
    const before = await tree(fixture.options.repositoryRoot, true);
    expect(await withdrawPublishedHost(options)).toEqual({ changed: false, hosts: [other.host] });
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    expect(verifyInputs).toHaveBeenCalledTimes(2);
    await cleanWorkspace(fixture.workspace);
  });

  it("withdraws the last host to an empty canonical list without accepting an empty host", async () => {
    const fixture = await setup();
    await publishCompletedHost({ ...fixture.options, completed: categorized() });
    expect(await withdrawPublishedHost(withdrawal(fixture.options))).toEqual({ changed: true, hosts: [] });
    expect(await readFile(join(fixture.options.repositoryRoot, "data/official-hosts.json"), "utf8")).toBe("[]\n");
    expect(await validatePublishedHosts(fixture.options)).toEqual([]);
    const before = await tree(fixture.options.repositoryRoot, true);
    await expect(
      publishCompletedHost({
        ...fixture.options,
        completed: {
          complete: true,
          host: { ...categorized().host, document_count: 0, document_roots: [] },
          documents: [],
        },
      }),
    ).rejects.toThrow();
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
  });

  it("does not create public output for an absent host and still awaits its guard", async () => {
    const fixture = await setup();
    const before = await tree(fixture.options.repositoryRoot, true);
    const verifyInputs = vi.fn(async () => {});
    expect(await withdrawPublishedHost({ ...withdrawal(fixture.options), verifyInputs })).toEqual({
      changed: false,
      hosts: [],
    });
    expect(verifyInputs).toHaveBeenCalledTimes(1);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
  });

  it.each(BOUNDARIES.flatMap((boundary) => [false, true].map((categories) => ({ boundary, categories }))))(
    "recovers withdrawal $boundary (categorized: $categories)",
    async ({ boundary, categories }) => {
      const fixture = await setup();
      const completed = categories ? categorized() : fixture.options.completed;
      await publishCompletedHost({ ...fixture.options, completed });
      const before = await tree(fixture.options.repositoryRoot, true);
      await expect(
        withdrawPublishedHost({
          ...withdrawal(fixture.options),
          testHook: (value) => {
            if (value === boundary) throw new Error(`Injected ${boundary}`);
          },
        }),
      ).rejects.toThrow(`Injected ${boundary}`);
      if (AFTER_COMMIT.has(boundary)) {
        expect(await validatePublishedHosts(fixture.options)).toEqual([]);
        for (const root of hostDocumentRoots(completed.host))
          await expect(lstat(join(fixture.options.repositoryRoot, root.path))).rejects.toMatchObject({
            code: "ENOENT",
          });
      } else expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
      await cleanWorkspace(fixture.workspace);
    },
  );

  it.each(["old-host-moved", "committed"] as const)("recovers SIGKILL during withdrawal at %s", async (boundary) => {
    const fixture = await setup();
    const completed = categorized();
    await publishCompletedHost({ ...fixture.options, completed });
    const before = await tree(fixture.options.repositoryRoot, true);
    const prepared = await preparedChild(withdrawal(fixture.options));
    await prepared.start(boundary);
    await stopChild(prepared.child);
    await expect(
      withdrawPublishedHost({
        ...withdrawal(fixture.options),
        verifyInputs: async () => {
          throw new Error("Stop after recovery");
        },
      }),
    ).rejects.toThrow("Stop after recovery");
    if (AFTER_COMMIT.has(boundary)) expect(await validatePublishedHosts(fixture.options)).toEqual([]);
    else expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    await cleanWorkspace(fixture.workspace);
  });

  it("shares the unchanged process-released publisher lock namespace", async () => {
    const fixture = await setup();
    await publishCompletedHost({ ...fixture.options, completed: categorized() });
    const before = await tree(fixture.options.repositoryRoot, true);
    const child = await pausedChild({ ...fixture.options, completed: categorized() }, "locked");
    await expect(withdrawPublishedHost(withdrawal(fixture.options))).rejects.toThrow(/lock is held/);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    await stopChild(child);
    expect((await withdrawPublishedHost(withdrawal(fixture.options))).changed).toBe(true);
    await cleanWorkspace(fixture.workspace);
  });

  it("finishes committed withdrawal cleanup from the marker alone", async () => {
    const fixture = await setup();
    await publishCompletedHost({ ...fixture.options, completed: categorized() });
    const prepared = await preparedChild(withdrawal(fixture.options));
    await prepared.start("before-cleanup");
    await stopChild(prepared.child);
    await rm(join(fixture.workspace, "transaction"), { recursive: true });
    await rm(join(fixture.workspace, "journal.json"));
    const before = await tree(fixture.options.repositoryRoot, true);
    expect(await withdrawPublishedHost(withdrawal(fixture.options))).toEqual({ changed: false, hosts: [] });
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    await cleanWorkspace(fixture.workspace);
  });

  it("awaits the withdrawal guard and never cleans an unowned stale backup", async () => {
    const fixture = await setup();
    await publishCompletedHost({ ...fixture.options, completed: categorized() });
    const before = await tree(fixture.options.repositoryRoot, true);
    await expect(
      withdrawPublishedHost({
        ...withdrawal(fixture.options),
        verifyInputs: async () => {
          throw new Error("Archive guard failure");
        },
      }),
    ).rejects.toThrow("Archive guard failure");
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    let backup = "";
    await expect(
      withdrawPublishedHost({
        ...withdrawal(fixture.options),
        testHook: async (boundary) => {
          if (boundary !== "committed") return;
          const journal = await stagedJournal(fixture.workspace);
          const index = journal.directories.length - 1;
          const directory = join(fixture.workspace, `transaction/old-host-${index}`);
          backup = join(directory, (await readdir(directory))[0]!);
          await writeFile(backup, "unowned archived bytes");
        },
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await readFile(backup, "utf8")).toBe("unowned archived bytes");
    expect(await readdir(fixture.workspace)).toContain("committed.json");
    expect(await validatePublishedHosts(fixture.options)).toEqual([]);
  });
});
