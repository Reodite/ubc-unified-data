import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
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
import type { CompletedHost, SearchDocument } from "./contracts.ts";
import { documentFilename, formatDocument, parseDocument, sha256 } from "./document-format.ts";
import { validatePublishedHosts } from "./public-validation.ts";
import { publishCompletedHost, type PublicationBoundary, type PublishCompletedHostOptions } from "./publication.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const TEMP = "/home/admin2/Projects/ubc-tmp";
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
  const root = await mkdtemp(`${TEMP}/text-publication-test-`);
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
      options.completed.host.document_root,
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

async function pausedChild(options: PublishCompletedHostOptions, boundary: PublicationBoundary): Promise<ChildProcess> {
  const module = fileURLToPath(new URL("./publication.ts", import.meta.url));
  const { verifyInputs: _, ...data } = options;
  const script = `import {publishCompletedHost} from ${JSON.stringify(module)};
    await publishCompletedHost({...${JSON.stringify(data)}, verifyInputs: async()=>{}, testHook: async(boundary)=>{
      if(boundary===${JSON.stringify(boundary)}) { process.stdout.write('READY\\n'); await new Promise(()=>setInterval(()=>{},1000)); }
    }});`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, TMPDIR: TEMP },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  let errors = "";
  child.stderr!.on("data", (chunk) => {
    errors += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("READY\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Child exited before boundary ${boundary}: ${code}\n${errors}`)));
  });
  await appendFile(`${TEMP}/text-publication-child-tests.log`, `${boundary}: ${errors}`);
  return child;
}

describe("completed host publication", () => {
  it("publishes only one exact Markdown file and the minimal index, then repeats without mutation", async () => {
    const fixture = await setup();
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
    expect(await readdir(join(fixture.options.repositoryRoot, before.host.document_root))).toEqual([
      documentFilename(before.documents[0]!.id),
    ]);
    expect(fixture.options.completed).toEqual(before);
    const published = await tree(fixture.options.repositoryRoot, true);
    expect((await publishCompletedHost({ ...fixture.options, verifyInputs })).changed).toBe(false);
    expect(await tree(fixture.options.repositoryRoot, true)).toEqual(published);
    expect(verifyInputs).toHaveBeenCalledTimes(2);
    await cleanWorkspace(fixture.workspace);
  });

  it("preserves upstream data, other hosts and existing modes while replacing the complete host directory", async () => {
    const fixture = await setup();
    const upstream = join(fixture.options.repositoryRoot, "data/prose");
    await mkdir(upstream, { recursive: true });
    await writeFile(join(upstream, "upstream.json"), "unchanged\u0000upstream");
    await publishCompletedHost({ ...fixture.options, completed: complete("other.ubc.ca") });
    await publishCompletedHost(fixture.options);
    const root = fixture.options.repositoryRoot;
    const hostDirectory = join(root, fixture.options.completed.host.document_root);
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
    const directory = join(fixture.options.repositoryRoot, fixture.options.completed.host.document_root);
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

  it.each(BOUNDARIES)("recovers SIGKILL at %s using process-released locks", async (boundary) => {
    const fixture = await setup();
    await publishCompletedHost(fixture.options);
    const before = await tree(fixture.options.repositoryRoot, true);
    const changed = complete("example.ubc.ca", "Replacement from crashed worker.\n");
    const child = await pausedChild({ ...fixture.options, completed: changed }, boundary);
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
    if (AFTER_COMMIT.has(boundary)) expect(await readFile(fixture.file)).toEqual(formatDocument(changed.documents[0]!));
    else expect(await tree(fixture.options.repositoryRoot, true)).toEqual(before);
    await cleanWorkspace(fixture.workspace);
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
    const unknown = join(fixture.options.repositoryRoot, fixture.options.completed.host.document_root, "unknown.json");
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
    beforeEach(async () => {
      fixture = await setup();
      const old = complete();
      const extra = complete("example.ubc.ca", "Second old document", "/second").documents[0]!;
      await publishCompletedHost({
        ...fixture.options,
        completed: { ...old, host: { ...old.host, document_count: 2 }, documents: [...old.documents, extra] },
      });
    });
    it.each(["partial backup cleanup", "commit marker alone"])("recovers interrupted %s", async (phase) => {
      const changed = complete("example.ubc.ca", "Committed replacement");
      const child = await pausedChild({ ...fixture.options, completed: changed }, "before-cleanup");
      child.kill("SIGKILL");
      await exited(child);
      children.delete(child);
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
