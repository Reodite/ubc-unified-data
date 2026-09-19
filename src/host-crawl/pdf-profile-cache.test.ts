import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTERNAL_ROOT, EXTERNAL_BOUNDARY } from "./paths.ts";
import { loadCachedPdfProfile } from "./pdf-profile-cache.ts";
import { PDF_EXECUTABLES, requirePdfProfile } from "./pdf-profile.ts";

const fixture = vi.hoisted(() => ({ dependencies: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const mapped = (path: unknown) =>
    typeof path === "string" && /^\/(?:usr|etc|lib64)\//.test(path) ? `${fixture.dependencies}${path}` : path;
  return {
    ...fs,
    ...Object.fromEntries(
      ["lstat", "stat", "readdir", "readlink", "realpath", "open"].map((name) => [
        name,
        vi.fn((path: unknown, ...args: unknown[]) =>
          (fs as unknown as Record<string, (...values: unknown[]) => unknown>)[name]!(mapped(path), ...args),
        ),
      ]),
    ),
  };
});
vi.mock("node:child_process", () => ({
  spawn: vi.fn((_executable: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      const output = args.includes("--list")
        ? "libnative.so.1 => /usr/lib/libnative.so.1 (0x234)\n/lib64/ld-linux-x86-64.so.2 (0x345)\n"
        : args.includes("-h")
          ? "Usage: pdftotext [options]\n  -layout : physical layout\n"
          : "synthetic native version 1\n";
      child.stdout.emit("data", Buffer.from(output));
      child.emit("close", 0, null);
    });
    return child;
  }),
}));
const { spawn: spawnActual } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
let root: string;
let cache: string;
let workers: ReturnType<typeof worker>[] = [];
let counter: string;
const physical = (path: string) => join(fixture.dependencies, path);

beforeEach(async () => {
  vi.clearAllMocks();
  workers = [];
  await mkdir(DEFAULT_EXTERNAL_ROOT, { recursive: true });
  root = await mkdtemp(join(DEFAULT_EXTERNAL_ROOT, "test-pdf-cache-"));
  cache = join(root, "batch");
  fixture.dependencies = join(root, "dependencies");
  for (const path of [
    ...Object.values(PDF_EXECUTABLES),
    "/usr/lib/libnative.so.1.0",
    "/usr/share/fonts/font.ttf",
    "/etc/fonts/fonts.conf",
    "/etc/ld.so.cache",
  ]) {
    await mkdir(dirname(physical(path)), { recursive: true });
    await writeFile(physical(path), `synthetic ${path}`);
  }
  await symlink(physical("/usr/lib/libnative.so.1.0"), physical("/usr/lib/libnative.so.1"));
});
// Prepare independent TypeScript runtimes before the ordinary lock-test deadline starts.
beforeEach(async ({ task }) => {
  const concurrent = task.name.startsWith("captures exactly once");
  const death = task.name.startsWith("releases a creation lock");
  if (concurrent || death) {
    const prepared = await workerFixture();
    counter = prepared.counter;
    workers = Array.from({ length: concurrent ? 5 : 2 }, (_, index) =>
      worker(
        prepared.script,
        join(root, "shared"),
        prepared.template,
        counter,
        death && index === 0 ? "hold" : "normal",
      ),
    );
    await Promise.all(workers.map(({ ready }) => ready));
  }
}, 30_000);
afterEach(async ({ task }) => {
  for (const { child } of workers) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.allSettled(workers.map(({ done }) => done));
  if (task.result?.state !== "fail") await rm(root, { recursive: true, force: true });
});

async function payload(): Promise<string> {
  return join(
    cache,
    (await readdir(cache)).find((name) => /^[a-f\d]{64}\.json$/.test(name))!,
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value)!;
}

async function workerFixture(): Promise<{
  script: string;
  template: string;
  counter: string;
}> {
  const profile = structuredClone(await loadCachedPdfProfile(cache));
  const resource = physical("/usr/share/fonts/font.ttf");
  const bytes = await readFile(resource);
  profile.manifest.resources = [
    {
      path: resource,
      kind: "file",
      resolvedPath: resource,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  profile.sha256 = createHash("sha256").update(canonical(profile.manifest)).digest("hex");
  const template = join(root, "template.json");
  await writeFile(template, JSON.stringify(profile));
  const script = join(root, "worker.mjs");
  const cacheModule = new URL("./pdf-profile-cache.ts", import.meta.url).href;
  const profileModule = new URL("./pdf-profile.ts", import.meta.url).href;
  await writeFile(
    script,
    `
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readOrCapturePdfProfileCache, loadCachedPdfProfile } from ${JSON.stringify(cacheModule)};
import { requirePdfProfile } from ${JSON.stringify(profileModule)};
const [directory, template, counter, mode] = process.argv.slice(2);
process.send('ready');
await new Promise(resolve => process.on('message', resolve));
const result = await readOrCapturePdfProfileCache(directory, async (_workspace, observe) => {
  if (mode === 'hold') {
    process.send('locked');
    await new Promise(() => {});
  }
  await appendFile(counter, 'capture\\n');
  const profile = JSON.parse(await readFile(template, 'utf8'));
  for (const resource of profile.manifest.resources) {
    const check = await observe(resource.path);
    await readFile(resource.path);
    await delay(75);
    await check();
  }
  return profile;
});
const authorized = await loadCachedPdfProfile(directory);
requirePdfProfile(authorized);
if (result.sha256 !== authorized.sha256) throw new Error('Profile changed');
process.stdout.write(authorized.sha256);
process.disconnect();
`,
  );
  return { script, template, counter: join(root, "captures.txt") };
}

function worker(script: string, directory: string, template: string, counter: string, mode = "normal") {
  const child = spawnActual(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), script, directory, template, counter, mode],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        UBC_TMP_ROOT: EXTERNAL_BOUNDARY,
        TSX_DISABLE_CACHE: "1",
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr!.on("data", (bytes) => {
    stderr += bytes;
  });
  const done = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 || signal === "SIGKILL" ? resolve(stdout) : reject(new Error(stderr)),
    );
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", (message) =>
      message === "ready" ? resolve() : reject(new Error("Unexpected worker readiness")),
    );
    child.once("exit", () => reject(new Error("Worker exited before readiness")));
    child.once("error", reject);
  });
  return { child, done, ready };
}

describe("private frozen-batch PDF cache", () => {
  it("authorizes immutable profiles and reuses capture with cache-byte hashing and complete BigInt identities only", async () => {
    const first = await loadCachedPdfProfile(cache);
    const nativeCalls = vi.mocked(spawn).mock.calls.length;
    const dependencyReads = () =>
      vi.mocked(open).mock.calls.filter(([path]) => String(path).startsWith(fixture.dependencies)).length;
    const reads = dependencyReads();
    const second = await loadCachedPdfProfile(cache);
    expect(second).toEqual(first);
    expect(() => requirePdfProfile(second)).not.toThrow();
    expect(Object.isFrozen(second.manifest.resources)).toBe(true);
    expect(vi.mocked(spawn).mock.calls).toHaveLength(nativeCalls);
    expect(nativeCalls).toBeGreaterThan(0);
    expect(dependencyReads()).toBe(reads);
    expect(() => requirePdfProfile(structuredClone(second))).toThrow("Capture or assert");
    const document = JSON.parse(await readFile(await payload(), "utf8"));
    expect(document.identities).toHaveLength(first.manifest.resources.length);
    const identity = document.identities.find((value: { path: string }) => value.path === "/usr/share/fonts/font.ttf");
    const stats = await lstat(physical(identity.path), { bigint: true });
    expect(identity.lstat).toMatchObject({
      dev: String(stats.dev),
      ino: String(stats.ino),
      mode: String(stats.mode),
      size: String(stats.size),
      mtimeNs: String(stats.mtimeNs),
      ctimeNs: String(stats.ctimeNs),
    });
    expect(document.identities.find((value: { path: string }) => value.path === "/etc/poppler")).toMatchObject({
      lstat: null,
      stat: null,
    });
    expect((await lstat(await payload())).mode & 0o777).toBe(0o400);
  });

  it.each(["bytes", "mode", "removed", "missing-root", "symlink", "directory"])(
    "fails closed on dependency %s changes without recapturing",
    async (mutation) => {
      await loadCachedPdfProfile(cache);
      const calls = vi.mocked(spawn).mock.calls.length;
      const font = physical("/usr/share/fonts/font.ttf");
      if (mutation === "bytes") {
        const before = await lstat(font);
        const bytes = await readFile(font);
        bytes[0] = bytes[0]! ^ 1;
        await writeFile(font, bytes);
        await utimes(font, before.atime, before.mtime);
      } else if (mutation === "mode") await chmod(font, 0o600);
      else if (mutation === "removed") await unlink(font);
      else if (mutation === "missing-root") await mkdir(physical("/etc/poppler"));
      else if (mutation === "directory") await writeFile(physical("/usr/share/fonts/new.ttf"), "new font");
      else {
        await unlink(physical("/usr/lib/libnative.so.1"));
        await symlink(font, physical("/usr/lib/libnative.so.1"));
      }
      await expect(loadCachedPdfProfile(cache)).rejects.toThrow("dependency identity changed");
      expect(vi.mocked(spawn).mock.calls).toHaveLength(calls);
    },
  );

  it.each(["bytes", "missing", "symlink", "writable"])(
    "rejects cache %s corruption without replacing the batch",
    async (mutation) => {
      await loadCachedPdfProfile(cache);
      const calls = vi.mocked(spawn).mock.calls.length;
      const path = await payload();
      if (mutation === "missing") await unlink(path);
      else if (mutation === "symlink") {
        const copy = join(root, "copy.json");
        await writeFile(copy, await readFile(path), { mode: 0o400 });
        await unlink(path);
        await symlink(copy, path);
      } else {
        await chmod(path, 0o600);
        if (mutation === "bytes") {
          const bytes = await readFile(path);
          bytes[bytes.length - 2] = 32;
          await writeFile(path, bytes);
          await chmod(path, 0o400);
        }
      }
      await expect(loadCachedPdfProfile(cache)).rejects.toThrow();
      expect(vi.mocked(spawn).mock.calls).toHaveLength(calls);
    },
  );

  it("rejects checkout-relative paths, checkout artifacts and symlinked cache directories", async () => {
    await expect(loadCachedPdfProfile("relative-cache")).rejects.toThrow("absolute");
    await expect(loadCachedPdfProfile(join(fileURLToPath(new URL("../..", import.meta.url)), "cache"))).rejects.toThrow(
      /external (?:to the repository|boundary)/,
    );
    await symlink(root, join(root, "alias"));
    await expect(loadCachedPdfProfile(join(root, "alias", "cache"))).rejects.toThrow("Symlink");
  });

  it("captures exactly once across five processes sharing a batch and authorizes in each process", async () => {
    for (const { child } of workers) child.send("start");
    const hashes = await Promise.all(workers.map(({ done }) => done));
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toMatch(/^[a-f\d]{64}$/);
    expect(await readFile(counter, "utf8")).toBe("capture\n");
  });

  it("releases a creation lock when its owner process dies", async () => {
    const [held, next] = workers;
    const locked = new Promise<void>((resolve, reject) => {
      held!.child.once("message", (message) =>
        message === "locked" ? resolve() : reject(new Error("Unexpected lock readiness")),
      );
      held!.child.once("exit", () => reject(new Error("Owner exited before lock acquisition")));
    });
    held!.child.send("start");
    await locked;
    held!.child.kill("SIGKILL");
    await held!.done;
    next!.child.send("start");
    expect(await next!.done).toMatch(/^[a-f\d]{64}$/);
    expect(await readFile(counter, "utf8")).toBe("capture\n");
  });
});
