import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SearchDocument, VettedHost } from "./contracts.ts";
import { documentFilename, formatDocument, sha256 } from "./document-format.ts";
import { formatHostList, validatePublishedHosts } from "./public-validation.ts";

const roots: string[] = [];
afterEach(async (context) => {
  for (const root of roots.splice(0)) {
    if (context.task.result?.state === "fail") console.error(`Preserved failed validation fixture: ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp("/home/admin2/Projects/ubc-tmp/text-validation-test-");
  roots.push(root);
  const hostname = "example.ubc.ca";
  const source_url = `https://${hostname}/page`;
  const body = "Original document.\n";
  const doc: SearchDocument = {
    id: `documents:official-web:${sha256(source_url).slice(0, 24)}`,
    hostname,
    title: "Example",
    source_url,
    retrieved_at: "2026-01-02T03:04:05.000Z",
    source_modified_at: null,
    snapshot_sha256: sha256("snapshot"),
    input_sha256: sha256("input"),
    body_sha256: sha256(body),
    content_sha256: sha256(`Example\n${body}`),
    content_markdown: body,
    warnings: [],
    alternate_urls: [],
    producer: {
      inputs_sha256: sha256("producer"),
      runtime: { node: "v26.8.1", icu: "78.2", unicode: "17.0", platform: "linux", arch: "x64" },
    },
  };
  const host: VettedHost = {
    hostname,
    title: "Example",
    homepage_url: `https://${hostname}/`,
    homepage_retrieved_at: doc.retrieved_at,
    homepage_sha256: sha256("homepage"),
    scope: "Public prose",
    document_root: `data/documents/${hostname}`,
    document_count: 1,
  };
  const registeredHosts = [hostname];
  const list = join(root, "data/official-hosts.json");
  const directory = join(root, host.document_root);
  const file = join(directory, documentFilename(doc.id));
  await mkdir(directory, { recursive: true });
  await writeFile(file, formatDocument(doc));
  await writeFile(list, formatHostList([host], registeredHosts));
  return {
    root,
    host,
    doc,
    registeredHosts,
    list,
    file,
    directory,
    options: { repositoryRoot: root, registeredHosts },
  };
}

describe("nonregular public artifacts", () => {
  let child: ChildProcess;
  let sequence = 0;
  beforeAll(async () => {
    const source = new URL("./public-validation.ts", import.meta.url).href;
    const script = `import {readRegularFile,validatePublishedHosts} from ${JSON.stringify(source)}; process.on('message', async m => { try { await (m.receipt ? readRegularFile(m.path) : validatePublishedHosts(m.options)); process.send({id:m.id,accepted:true}); } catch(error) { process.send({id:m.id,error:String(error.message)}); } }); process.send({ready:true});`;
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr!.on("data", (bytes) => {
      stderr += String(bytes);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("message", (message) => {
        if ((message as { ready?: boolean }).ready) resolve();
        else reject(new Error("Missing child readiness acknowledgement"));
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Validation child exited before readiness: ${stderr}`)));
    });
  });
  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  it.each(["list", "file", "receipt"])("rejects a FIFO promptly without deleting the %s artifact", async (target) => {
    const fixture = await setup();
    const path =
      target === "list" ? fixture.list : target === "file" ? fixture.file : join(fixture.root, "receipt.json");
    await rm(path, { force: true });
    execFileSync("mkfifo", [path]);
    const before = await lstat(path);
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout>;
    let receive: (message: unknown) => void;
    const result = await new Promise<{ error?: string }>((resolve, reject) => {
      receive = (message) => {
        const result = message as { id?: number; error?: string };
        if (result.id === id) resolve(result);
      };
      child.on("message", receive);
      timer = setTimeout(() => reject(new Error("Ready child file operation exceeded 1000ms")), 1000);
      child.send({ id, receipt: target === "receipt", path, options: fixture.options });
    }).finally(() => {
      clearTimeout(timer);
      child.off("message", receive);
    });
    expect(result.error).toMatch(/regular/);
    const after = await lstat(path);
    expect(after.isFIFO()).toBe(true);
    expect([after.ino, after.dev, after.mode]).toEqual([before.ino, before.dev, before.mode]);
  });
});

describe("published host validation", () => {
  it("validates only minimal output and preserves unrelated upstream data", async () => {
    const fixture = await setup();
    const upstream = join(fixture.root, "data/prose");
    await mkdir(upstream);
    await writeFile(join(upstream, "unrelated.json"), "not even JSON\u0000");
    const before = await readFile(fixture.file);
    expect(await validatePublishedHosts(fixture.options)).toEqual([fixture.host]);
    expect(await readFile(fixture.file)).toEqual(before);
    expect(await readFile(join(upstream, "unrelated.json"), "utf8")).toBe("not even JSON\u0000");
  });

  it("requires explicit first-publication absence", async () => {
    const fixture = await setup();
    await rm(join(fixture.root, "data"), { recursive: true });
    await expect(validatePublishedHosts(fixture.options)).rejects.toThrow(/Missing/);
    expect(await validatePublishedHosts({ ...fixture.options, allowAbsent: true })).toEqual([]);
    await mkdir(fixture.directory, { recursive: true });
    await expect(validatePublishedHosts({ ...fixture.options, allowAbsent: true })).rejects.toThrow(/Missing/);
  });

  it.each(["unknown.json", "sidecar.csv", "bad.md", "subdirectory"])(
    "rejects unknown document tree entry %s",
    async (name) => {
      const fixture = await setup();
      if (name === "subdirectory") await mkdir(join(fixture.directory, name));
      else await writeFile(join(fixture.directory, name), "unknown");
      await expect(validatePublishedHosts(fixture.options)).rejects.toThrow();
    },
  );

  it("rejects unregistered or noncanonical hosts and wrong counts", async () => {
    const fixture = await setup();
    await expect(validatePublishedHosts({ ...fixture.options, registeredHosts: [] })).rejects.toThrow(/Unregistered/);
    await writeFile(fixture.list, JSON.stringify([{ ...fixture.host, document_count: 2 }]));
    await expect(validatePublishedHosts(fixture.options)).rejects.toThrow();
    expect(() => formatHostList([{ ...fixture.host, document_root: "../escape" }], fixture.registeredHosts)).toThrow();
    expect(() => formatHostList([{ ...fixture.host, hostname: "EXAMPLE.ubc.ca" }], fixture.registeredHosts)).toThrow();
  });

  it("rejects source/alternate URL reuse", async () => {
    const fixture = await setup();
    const source_url = `https://${fixture.host.hostname}/another`;
    const second = {
      ...fixture.doc,
      source_url,
      id: `documents:official-web:${sha256(source_url).slice(0, 24)}`,
      alternate_urls: [fixture.doc.source_url],
    };
    await writeFile(join(fixture.directory, documentFilename(second.id)), formatDocument(second));
    await writeFile(fixture.list, formatHostList([{ ...fixture.host, document_count: 2 }], fixture.registeredHosts));
    await expect(validatePublishedHosts(fixture.options)).rejects.toThrow(/Duplicate document URL/);
  });

  it.each(["file", "directory", "list", "data", "ancestor"])("rejects a symlink at %s", async (target) => {
    const fixture = await setup();
    if (target === "ancestor") {
      const alias = `${fixture.root}-alias`;
      roots.push(alias);
      await symlink(fixture.root, alias);
      await expect(validatePublishedHosts({ ...fixture.options, repositoryRoot: alias })).rejects.toThrow(/Symlink/);
      return;
    }
    const path =
      target === "file"
        ? fixture.file
        : target === "directory"
          ? fixture.directory
          : target === "list"
            ? fixture.list
            : join(fixture.root, "data");
    await rm(path, { recursive: true });
    await symlink(fixture.root, path);
    await expect(validatePublishedHosts(fixture.options)).rejects.toThrow();
  });
});
