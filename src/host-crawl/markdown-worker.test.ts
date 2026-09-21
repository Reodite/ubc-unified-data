import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inspectMarkdownSource } from "./markdown-inspection.mjs";
import { createMarkdownGuardPolicy, type MarkdownArtifact } from "./markdown-profile.ts";
import {
  createMarkdownResponseDecoder,
  encodeMarkdownRequest,
  encodeMarkdownResponse,
  MARKDOWN_PROTOCOL_LIMITS,
  prepareMarkdownRequest,
} from "./markdown-protocol.mjs";

interface Package {
  root: string;
  name: string;
  version: string;
  type: "module" | "commonjs";
  dependencies: { name: string; range: string; root: string }[];
}
interface Policy {
  version: number;
  files: { path: string; sha256: string; format: string }[];
  packages: Package[];
  builtins: { parent: string; allowed: string[] }[];
}
interface Mount {
  path: string;
  target: string;
}
interface Fixture {
  root: string;
  files: Map<string, Buffer>;
  policy: Policy;
  digest: string;
}
interface Result {
  code: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: string;
  status: string;
  timeout: boolean;
  inputError: boolean;
}

const sourceDirectory = import.meta.dirname;
const source = Buffer.from("# 界 Guide\n\nA literal `code` and [IDN](https://例え.テスト/道).\n");
const refusal = "MARKDOWN_WORKER_REFUSED\n";
const environment = { LC_ALL: "C", LANG: "C", TZ: "UTC", UV_THREADPOOL_SIZE: "1" };
const fetchGuard = vi.fn(() => {
  throw new Error("Network forbidden in worker tests");
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const builtins = [
  {
    parent: "/app/markdown-bootstrap.mjs",
    allowed: ["node:crypto", "node:fs", "node:module", "node:url", "node:util"],
  },
  { parent: "/app/markdown-contract.mjs", allowed: [] },
  { parent: "/app/markdown-inspection.mjs", allowed: ["node:crypto", "node:util"] },
  { parent: "/app/markdown-protocol.mjs", allowed: ["node:buffer", "node:crypto", "node:util"] },
  { parent: "/app/markdown-worker.mjs", allowed: [] },
];
const files = new Map<string, Buffer>();
const directories = new Set<string>(["/app"]);
const native: Mount[] = [];
const observations: object[] = [];
let evidence: string;
let launcher: string;
let capability = "not probed";

beforeAll(() => {
  vi.stubGlobal("fetch", fetchGuard);
});
afterAll(async () => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  if (evidence)
    await writeFile(join(evidence, "observations.json"), JSON.stringify({ capability, observations }, null, 2));
});

async function put(path: string, bytes: Uint8Array, mode = 0o400) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode });
}

async function readTree(physical: string, virtual: string) {
  expect((await lstat(physical)).isSymbolicLink()).toBe(false);
  directories.add(virtual);
  for (const name of (await readdir(physical)).sort()) {
    const path = join(physical, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) await readTree(path, `${virtual}/${name}`);
    else {
      expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
      expect(stat.size).toBeLessThanOrEqual(8388608);
      files.set(`${virtual}/${name}`, await readFile(path));
    }
  }
}

function makePolicy(input: Map<string, Buffer>): Policy {
  const packages: Package[] = [];
  const manifests = new Map<string, any>();
  for (const [path, bytes] of input) {
    if (!path.endsWith("/package.json")) continue;
    const manifest = JSON.parse(bytes.toString());
    const root = dirname(path);
    manifests.set(root, manifest);
    packages.push({
      root,
      name: manifest.name,
      version: manifest.version,
      type: manifest.type ?? "commonjs",
      dependencies: [],
    });
  }
  packages.sort((a, b) => (a.root < b.root ? -1 : 1));
  for (const pkg of packages) {
    pkg.dependencies = Object.entries(manifests.get(pkg.root).dependencies ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, range]) => {
        let root: string | undefined;
        for (let cursor = pkg.root; cursor.startsWith("/app"); cursor = dirname(cursor)) {
          const candidate = `${cursor}/node_modules/${name}`;
          if (packages.some((target) => target.root === candidate)) {
            root = candidate;
            break;
          }
        }
        if (!root) throw new Error(`Missing synthetic package ${name}`);
        return { name, range: range as string, root };
      });
  }
  return {
    version: 1,
    files: [...input]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, bytes]) => {
        const pkg = [...packages].reverse().find((item) => path.startsWith(`${item.root}/`))!;
        const format = path.endsWith(".mjs")
          ? "module"
          : path.endsWith(".cjs")
            ? "commonjs"
            : path.endsWith(".json")
              ? "json"
              : path.endsWith(".js")
                ? pkg.type
                : "data";
        return { path, sha256: digest(bytes), format };
      }),
    packages,
    builtins: structuredClone(builtins),
  };
}

async function fixture(name: string, additions: Record<string, string> = {}, mutate?: (policy: Policy) => void) {
  const root = await mkdtemp(join(evidence, `${name}-`));
  const input = new Map(files);
  for (const [path, content] of Object.entries(additions)) input.set(path, Buffer.from(content));
  const policy = makePolicy(input);
  mutate?.(policy);
  const policyBytes = Buffer.from(JSON.stringify(policy));
  for (const [path, bytes] of input) await put(join(root, path), bytes);
  await put(join(root, "/app/markdown-guard-policy.json"), policyBytes);
  return { root, files: input, policy, digest: digest(policyBytes) };
}

async function replace(f: Fixture, path: string, bytes: Uint8Array) {
  const target = join(f.root, path);
  await chmod(target, 0o600);
  await writeFile(target, bytes);
  await chmod(target, 0o400);
}

async function run(
  f: Fixture,
  wire: Uint8Array,
  options: { args?: string[]; omit?: string; cwd?: string; entry?: string } = {},
): Promise<Result> {
  const mounts = [
    ...native,
    ...[...f.files.keys(), "/app/markdown-guard-policy.json"].map((path) => ({ path, target: join(f.root, path) })),
  ].filter((entry) => entry.path !== options.omit);
  const handles = [];
  try {
    handles.push(await open(launcher, constants.O_RDONLY | constants.O_NOFOLLOW));
    for (const mount of mounts) handles.push(await open(mount.target, constants.O_RDONLY | constants.O_NOFOLLOW));
    const args = [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      "--disable-userns",
      "--assert-userns-disabled",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--chdir",
      options.cwd ?? "/app",
      "--json-status-fd",
      "3",
      ...Object.entries({ ...environment, PWD: "/app" }).flatMap(([key, value]) => ["--setenv", key, value]),
      ...[...directories].sort().flatMap((path) => ["--dir", path]),
      ...mounts.flatMap((mount, index) => ["--ro-bind-fd", String(index + 5), mount.path]),
      "--dev-bind",
      "/dev/null",
      "/dev/null",
      "--remount-ro",
      "/",
      "--",
      "/runtime/prlimit",
      "--cpu=3:3",
      "--nofile=64:64",
      "--fsize=0:0",
      "--core=0:0",
      "--stack=8388608:8388608",
      "--",
      "/runtime/node",
      "--max-old-space-size=128",
      "--max-semi-space-size=4",
      "--v8-pool-size=1",
      "--permission",
      ...[...f.files.keys(), "/app/markdown-guard-policy.json"].map((path) => `--allow-fs-read=${path}`),
      "--no-addons",
      "--no-global-search-paths",
      "--disable-proto=throw",
      "--disallow-code-generation-from-strings",
      "--openssl-config=/dev/null",
      options.entry ?? "/app/markdown-worker.mjs",
      ...(options.args ?? [f.digest]),
    ];
    await writeFile(join(f.root, "invocation.json"), JSON.stringify({ args, environment, mounts }, null, 2));
    const child = spawn("/proc/self/fd/4", args, {
      cwd: evidence,
      env: environment,
      stdio: ["pipe", "pipe", "pipe", "pipe", ...handles.map((handle) => handle.fd)],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [],
      status: Buffer[] = [];
    let outputBytes = 0,
      errorBytes = 0,
      statusBytes = 0,
      timeout = false,
      inputError = false;
    const timer = setTimeout(() => {
      timeout = true;
      child.kill("SIGKILL");
    }, 5000);
    try {
      child.stdout!.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MARKDOWN_PROTOCOL_LIMITS.responseFrameBytes) child.kill("SIGKILL");
        else stdout.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        errorBytes += chunk.length;
        if (errorBytes > 16384) child.kill("SIGKILL");
        else stderr.push(chunk);
      });
      const statusStream = child.stdio[3]! as NodeJS.ReadableStream;
      statusStream.on("data", (chunk: Buffer) => {
        statusBytes += chunk.length;
        if (statusBytes > 8192) child.kill("SIGKILL");
        else status.push(chunk);
      });
      child.stdin!.on("error", () => {
        inputError = true;
      });
      const completion = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      child.stdin!.end(wire);
      const result = {
        ...(await completion),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString(),
        status: Buffer.concat(status).toString(),
        timeout,
        inputError,
      };
      observations.push({
        fixture: basename(f.root),
        ...result,
        stdout: { bytes: result.stdout.length, sha256: digest(result.stdout) },
      });
      await writeFile(
        join(f.root, "result.json"),
        JSON.stringify({ ...result, stdout: { bytes: result.stdout.length, sha256: digest(result.stdout) } }, null, 2),
      );
      await writeFile(join(f.root, "stdout.bin"), result.stdout);
      return result;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

function refused(result: Result, output = false) {
  expect(result.timeout).toBe(false);
  expect(result.signal).toBeNull();
  expect(result.code).toBe(1);
  expect(result.stderr).toBe(refusal);
  if (!output) expect(result.stdout.length).toBe(0);
  else
    expect(result.stdout).toEqual(
      Buffer.from(encodeMarkdownResponse(inspectMarkdownSource(source, []), prepareMarkdownRequest(source, []))),
    );
}

async function accepted(f: Fixture, bytes: Buffer = source, titles: (string | null)[] = []) {
  const request = prepareMarkdownRequest(bytes, titles);
  const expected = inspectMarkdownSource(bytes, titles);
  const result = await run(f, encodeMarkdownRequest(request));
  expect(result.timeout).toBe(false);
  expect(result.inputError).toBe(false);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toEqual(Buffer.from(encodeMarkdownResponse(expected, request)));
  const decoder = createMarkdownResponseDecoder(request);
  decoder.push(result.stdout);
  expect(decoder.finish()).toEqual(expected);
  expect(result.status).toMatch(/"child-pid"/);
  expect(result.status).toMatch(/"exit-code": 0/);
  return result;
}

const worker = "import { runMarkdownWorker } from './markdown-bootstrap.mjs';\nawait runMarkdownWorker();\n";
const noFetch = "globalThis.fetch = () => { throw new Error('fixture network forbidden'); };\n";
const wire = () => encodeMarkdownRequest(prepareMarkdownRequest(source, []));

// This setup budget covers one bounded native copy and package inventory, not retry attempts.
describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "fixed worker in exact-file sparse namespaces",
  () => {
    beforeAll(async () => {
      const parent =
        process.env["UBC_MARKDOWN_WORKER_EVIDENCE"] ??
        join(process.env["UBC_TMP_ROOT"] ?? tmpdir(), "markdown-worker-evidence");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      evidence = await mkdtemp(join(parent, "run-"));
      const nullStat = await lstat("/dev/null");
      expect(nullStat.isCharacterDevice() && !nullStat.isSymbolicLink() && nullStat.rdev === 259).toBe(true);
      const recipe = [
        [process.execPath, "/runtime/node"],
        ["/usr/bin/prlimit", "/runtime/prlimit"],
        ["/usr/lib/ld-linux-x86-64.so.2", "/lib64/ld-linux-x86-64.so.2"],
        ...[
          "libc.so.6",
          "libm.so.6",
          "libstdc++.so.6",
          "libgcc_s.so.1",
          "libatomic.so.1",
          "libdl.so.2",
          "libpthread.so.0",
          "libsmartcols.so.1",
        ].map((name) => [`/usr/lib/${name}`, `/usr/lib/${name}`]),
      ];
      let total = 0;
      for (const [input, path] of [...recipe, ["/usr/bin/bwrap", "launcher"]] as [string, string][]) {
        const real = await realpath(input);
        const stat = await lstat(real);
        expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
        expect(stat.size).toBeLessThanOrEqual(268435456);
        total += stat.size;
        expect(total).toBeLessThanOrEqual(536870912);
        const target = join(evidence, "native", basename(path));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(real, target, constants.COPYFILE_EXCL);
        await chmod(target, stat.mode & 0o111 ? 0o500 : 0o400);
        if (path === "launcher") launcher = target;
        else native.push({ path, target });
      }
      expect(native.length).toBe(11);
      for (const name of ["markdown-it", "argparse", "linkify-it", "mdurl", "punycode.js", "uc.micro"]) {
        await readTree(
          await realpath(resolve(sourceDirectory, "../../node_modules", name)),
          `/app/node_modules/${name}`,
        );
      }
      for (const name of ["bootstrap", "worker", "contract", "inspection", "protocol"]) {
        files.set(`/app/markdown-${name}.mjs`, await readFile(join(sourceDirectory, `markdown-${name}.mjs`)));
      }
      files.set(
        "/app/package.json",
        Buffer.from(
          JSON.stringify({
            name: "ubc-markdown-runtime",
            version: "1.0.0",
            type: "module",
            dependencies: { "markdown-it": "15.0.2" },
          }),
        ),
      );
      const probe = await fixture("capability-probe", {
        "/app/markdown-worker.mjs": "process.stdout.end('SPARSE_CAPABILITY');\n",
      });
      const result = await run(probe, Buffer.alloc(0));
      capability =
        result.code === 0 && result.stderr === "" && result.stdout.toString() === "SPARSE_CAPABILITY"
          ? "available"
          : "missing-or-incompatible";
      await writeFile(join(evidence, "capability.json"), JSON.stringify({ capability, result }, null, 2));
      expect(
        capability,
        "Missing/incompatible namespace or native capability; not a worker refusal and no downgrade attempted",
      ).toBe("available");
    }, 30000);

    it("keeps the production entry fixed and imports no parser before guard installation", async () => {
      const entry = files.get("/app/markdown-worker.mjs")!.toString();
      expect(entry.trim()).toBe(
        'import { runMarkdownWorker } from "./markdown-bootstrap.mjs";\n\nawait runMarkdownWorker();',
      );
      const bootstrap = files.get("/app/markdown-bootstrap.mjs")!.toString();
      expect([...bootstrap.matchAll(/^import .+ from "([^"]+)";/gm)].map((match) => match[1])).toEqual([
        "node:crypto",
        "node:fs",
        "node:module",
        "node:url",
      ]);
      expect([...bootstrap.matchAll(/^export /gm)].length).toBe(1);
      expect(bootstrap).not.toMatch(/error\.message|process\.exit\(/);
      expect(bootstrap.indexOf("installGuard(policy);", bootstrap.indexOf("export async"))).toBeLessThan(
        bootstrap.indexOf('await import("./markdown-protocol.mjs")'),
      );
      await accepted(await fixture("production-normal"));
    });

    it.each(["installed", "maximum-range"])(
      "accepts the exact %s policy emitted by the profile encoder",
      async (kind) => {
        const additions: Record<string, string> = {};
        if (kind === "maximum-range") {
          const path = "/app/node_modules/markdown-it/package.json";
          const manifest = JSON.parse(files.get(path)!.toString("utf8"));
          manifest.dependencies.argparse = manifest.dependencies.argparse.padEnd(255, " ");
          additions[path] = JSON.stringify(manifest);
        }
        const f = await fixture(`profile-policy-${kind}`, additions);
        const artifacts: MarkdownArtifact[] = [...f.files].map(([path, bytes]) => ({
          id: path.slice(1),
          role:
            path === "/app/package.json"
              ? "app-metadata"
              : path.startsWith("/app/node_modules/")
                ? "package"
                : "source",
          virtual_path: path,
          bytes: bytes.length,
          sha256: digest(bytes),
          mode: 0o400,
          elf: null,
        }));
        const generated = createMarkdownGuardPolicy(artifacts, f.policy.packages);
        expect(JSON.parse(Buffer.from(generated.bytes).toString("utf8"))).toEqual(f.policy);
        await replace(f, "/app/markdown-guard-policy.json", generated.bytes);
        await accepted({ ...f, digest: generated.sha256 });
      },
    );

    it.each([
      ["body overrides hint", source, ["Different hint"]],
      ["advertised title", Buffer.from("Owned paragraph.\n"), [null, "", "Native title", "Native title"]],
      [
        "source code remains data",
        Buffer.from("# Source\n\n```\nprocess.exit(9); fetch('https://example.test');\n```\n"),
        [],
      ],
    ] as [string, Buffer, (string | null)[]][])("preserves %s exactly", async (name, bytes, titles) => {
      await accepted(
        await fixture(name.replaceAll(" ", "-"), { "/app/markdown-worker.mjs": noFetch + worker }),
        bytes,
        titles,
      );
    });

    it("accepts maximum source bytes and six bounded title hints without rewriting", async () => {
      const bytes = Buffer.from(`# Guide\n\n${`${"x".repeat(1023)}\n`.repeat(1024)}`);
      await accepted(
        await fixture("maximum-source"),
        bytes.subarray(0, 1048576),
        Array<string>(6).fill("界".repeat(4096)),
      );
    });

    it("returns the exact maximum honest metadata frame and refuses one-byte overflow", async () => {
      const make = (extra: number) =>
        Buffer.from(
          Array.from(
            { length: 33 },
            (_, index) => `[${"x".repeat(index < 32 ? 7900 : extra)}](https://example.org/${index})`,
          ).join("\n\n"),
        );
      const titles = ["Advertisement"];
      const extra = 1 + 262144 - Buffer.byteLength(JSON.stringify(inspectMarkdownSource(make(1), titles)));
      const result = await accepted(await fixture("maximum-metadata"), make(extra), titles);
      expect(result.stdout.length).toBe(262183);
      refused(
        await run(
          await fixture("metadata-overflow"),
          encodeMarkdownRequest(prepareMarkdownRequest(make(extra + 1), titles)),
        ),
      );
    });

    it.each([
      ["invalid UTF8", Buffer.from([0xff])],
      ["raw HTML", Buffer.from("# Private title\n\n<script>source-secret</script>\n")],
      ["unsafe source", Buffer.from("# Guide\n\nsource-secret\u202e\n")],
      ["missing title", Buffer.from("source-secret\n")],
      ["unsafe link", Buffer.from("# Guide\n\n[secret](javascript:alert)\n")],
    ] as [string, Buffer][])("refuses %s without source diagnostics", async (name, bytes) => {
      refused(
        await run(await fixture(name.replaceAll(" ", "-")), encodeMarkdownRequest(prepareMarkdownRequest(bytes, []))),
      );
    });

    it.each([
      ["empty", () => Buffer.alloc(0)],
      ["truncated", () => wire().subarray(0, -1)],
      ["trailing", () => Buffer.concat([wire(), Buffer.from("source-secret")])],
      ["second frame", () => Buffer.concat([wire(), wire()])],
      [
        "bad magic",
        () => {
          const bytes = Buffer.from(wire());
          bytes[0] = 0;
          return bytes;
        },
      ],
      [
        "bad source hash",
        () => {
          const bytes = Buffer.from(wire());
          bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
          return bytes;
        },
      ],
      [
        "header overflow",
        () => {
          const bytes = Buffer.from(wire());
          bytes.writeUInt32BE(163841, 8);
          return bytes;
        },
      ],
      [
        "source overflow",
        () => {
          const bytes = Buffer.from(wire());
          bytes.writeUInt32BE(1048577, 12);
          return bytes;
        },
      ],
      ["aggregate overflow", () => Buffer.alloc(MARKDOWN_PROTOCOL_LIMITS.requestFrameBytes + 1)],
    ] as [string, () => Uint8Array][])("refuses %s request through EOF", async (name, make) => {
      refused(await run(await fixture(name.replaceAll(" ", "-")), make()));
    });

    it("refuses invalid advertisement evidence before loading the parser", async () => {
      const request = prepareMarkdownRequest(source, []);
      const header = Buffer.from(
        JSON.stringify({
          version: 1,
          source_bytes: request.source_bytes,
          source_bytes_sha256: request.source_bytes_sha256,
          advertised_titles: ["source-secret\u202e"],
        }),
      );
      const prefix = Buffer.alloc(16);
      prefix.write("UBCMDQ01");
      prefix.writeUInt32BE(header.length, 8);
      prefix.writeUInt32BE(source.length, 12);
      const f = await fixture("invalid-title-evidence", {
        "/app/markdown-inspection.mjs": "process.stderr.write('PARSER_EXECUTED');\n",
      });
      refused(await run(f, Buffer.concat([prefix, header, source])));
    });

    it.each([[], ["A".repeat(64)], ["0".repeat(63)], ["source-secret"], ["0".repeat(64)], ["0".repeat(64), "extra"]])(
      "refuses invalid trusted digest arguments %j",
      async (...args) => {
        refused(await run(await fixture("bad-arguments"), wire(), { args }));
      },
    );

    it.each([
      [
        "version",
        (policy: Policy) => {
          policy.version = 2;
        },
      ],
      [
        "extra field",
        (policy: any) => {
          policy.secret = "source-secret";
        },
      ],
      [
        "unsorted files",
        (policy: Policy) => {
          policy.files.reverse();
        },
      ],
      [
        "duplicate file",
        (policy: Policy) => {
          policy.files.push(policy.files[0]!);
        },
      ],
      [
        "bad hash",
        (policy: Policy) => {
          policy.files[0]!.sha256 = "source-secret";
        },
      ],
      [
        "wrong format",
        (policy: Policy) => {
          policy.files.find((file) => file.path.endsWith("markdown-protocol.mjs"))!.format = "commonjs";
        },
      ],
      [
        "policy includes itself",
        (policy: Policy) => {
          policy.files.push({ path: "/app/markdown-guard-policy.json", sha256: "0".repeat(64), format: "json" });
          policy.files.sort((a, b) => (a.path < b.path ? -1 : 1));
        },
      ],
      [
        "builtin widening",
        (policy: Policy) => {
          policy.builtins[1]!.allowed.push("node:fs");
        },
      ],
      [
        "package builtin",
        (policy: Policy) => {
          policy.builtins.push({ parent: "/app/node_modules/markdown-it/dist/markdown-it.mjs", allowed: ["node:fs"] });
        },
      ],
      [
        "unsafe path",
        (policy: Policy) => {
          policy.files[0]!.path = "/app/../source-secret";
        },
      ],
      [
        "wrong package identity",
        (policy: Policy) => {
          policy.packages[0]!.name = "source-secret";
        },
      ],
      [
        "wrong package type",
        (policy: Policy) => {
          policy.packages.find((pkg) => pkg.name === "entities")!.type = "commonjs";
        },
      ],
      [
        "unknown dependency",
        (policy: Policy) => {
          policy.packages[0]!.dependencies[0]!.root = "/app/node_modules/missing";
        },
      ],
      [
        "wrong range",
        (policy: Policy) => {
          policy.packages[0]!.dependencies[0]!.range = "source-secret";
        },
      ],
      [
        "file cap",
        (policy: Policy) => {
          while (policy.files.length <= 512) policy.files.push(policy.files[0]!);
        },
      ],
    ] as [string, (policy: Policy) => void][])("validates exact policy: %s", async (name, mutate) => {
      refused(await run(await fixture(name.replaceAll(" ", "-"), {}, mutate), wire()));
    });

    it.each(["whitespace", "duplicate-key", "invalid-json", "oversized"])(
      "refuses %s policy before parser import",
      async (kind) => {
        const f = await fixture(`policy-${kind}`, {
          "/app/markdown-inspection.mjs":
            "process.stderr.write('PARSER_EXECUTED'); throw new Error('source-secret');\n",
        });
        const original = JSON.stringify(f.policy);
        const bytes = Buffer.from(
          kind === "whitespace"
            ? `${original}\n`
            : kind === "duplicate-key"
              ? original.replace('"version":1', '"version":1,"version":1')
              : kind === "oversized"
                ? " ".repeat(1048577)
                : "{source-secret",
        );
        await replace(f, "/app/markdown-guard-policy.json", bytes);
        f.digest = digest(bytes);
        refused(await run(f, wire()));
      },
    );

    it("verifies policy bytes before parsing them", async () => {
      const f = await fixture("hash-before-parse");
      const bootstrap = f.files
        .get("/app/markdown-bootstrap.mjs")!
        .toString()
        .replace(
          'const policy = JSON.parse(bytes.toString("utf8"));',
          "process.stderr.write('POLICY_PARSED'); const policy = JSON.parse(bytes.toString(\"utf8\"));",
        );
      await replace(f, "/app/markdown-bootstrap.mjs", Buffer.from(bootstrap));
      await replace(f, "/app/markdown-guard-policy.json", Buffer.from("source-secret"));
      refused(await run(f, wire()));
    });

    it.each(["/app/node_modules/mdurl/index.mjs", "/app/markdown-guard-policy.json"])(
      "refuses missing exact resource %s",
      async (omit) => {
        refused(await run(await fixture("missing-resource"), wire(), { omit }));
      },
    );

    it("refuses changed inventoried bytes without executing them", async () => {
      const f = await fixture("changed-bytes");
      await replace(
        f,
        "/app/node_modules/mdurl/index.mjs",
        Buffer.from("process.stderr.write('PARSER_EXECUTED'); throw new Error('source-secret');\n"),
      );
      refused(await run(f, wire()));
    });

    it("uses the fixed working directory and entry only", async () => {
      refused(await run(await fixture("wrong-cwd"), wire(), { cwd: "/" }));
      const f = await fixture("wrong-entry", { "/app/alternate.mjs": worker });
      refused(await run(f, wire(), { entry: "/app/alternate.mjs" }));
    });

    it.each([
      ["undeclared package", "await import('mdurl')"],
      ["relative package escape", "await import('./node_modules/mdurl/index.mjs')"],
      ["absolute file", "await import('file:///app/markdown-contract.mjs')"],
      ["data URL", "await import('data:text/javascript,export default 1')"],
      ["query alias", "await import('./markdown-contract.mjs?secret')"],
      ["fragment alias", "await import('./markdown-contract.mjs#secret')"],
      ["unknown relative", "await import('./source-secret.mjs')"],
      ["cached builtin", "await import('node:crypto')"],
      ["data file", "await import('./note.txt')"],
    ])("keeps caught %s resolution failures sticky", async (name, operation) => {
      const f = await fixture(name!.replaceAll(" ", "-"), {
        "/app/markdown-worker.mjs": `${noFetch}${worker}try { ${operation}; } catch {}\n`,
        "/app/note.txt": "source-secret",
      });
      const result = await run(f, wire());
      refused(result, true);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("refuses a caught load failure even after a valid response was written", async () => {
      const f = await fixture("late-load-failure", {
        "/app/markdown-worker.mjs": `${worker}try { await import('./leaf.json'); } catch {}\n`,
        "/app/leaf.json": "{}",
      });
      const result = await run(f, wire());
      refused(result, true);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("keeps beforeExit caught failures sticky without a forced successful exit", async () => {
      const f = await fixture("before-exit-failure", {
        "/app/markdown-worker.mjs": `${worker}process.once('beforeExit', () => { import('node:crypto').catch(() => {}); });\n`,
      });
      const result = await run(f, wire());
      refused(result, true);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("does not let caught violations reset successful exit status", async () => {
      const f = await fixture("reset-exit-status", {
        "/app/markdown-worker.mjs": `${worker}try { await import('node:crypto'); } catch { process.exitCode = 0; }\n`,
      });
      refused(await run(f, wire()), true);
    });

    it("allows CJS and ESM same-package imports and repeated cache hits", async () => {
      const f = await fixture("cache-success", {
        "/app/markdown-worker.mjs": `${noFetch}${worker}const a = await import('./leaf.cjs'); const b = await import('./leaf.cjs'); const c = await import('./leaf.mjs'); const d = await import('./leaf.mjs'); const json = await import('./leaf.json', { with: { type: 'json' } }); if (a !== b || c !== d || a.default !== 7 || c.default !== 9 || json.default.value !== 11) throw new Error('fixture');\n`,
        "/app/leaf.cjs": "module.exports = require('./value.cjs') + require('./value.cjs');\n",
        "/app/value.cjs": "module.exports = 3.5;\n",
        "/app/leaf.mjs": "export default 9;\n",
        "/app/leaf.json": '{"value":11}',
      });
      await accepted(f);
    });

    it.each([
      "require('node:crypto')",
      "require('./missing.cjs')",
      "require('./node_modules/mdurl/build/index.cjs.js')",
    ])("keeps caught CommonJS refusal sticky: %s", async (operation) => {
      const f = await fixture("caught-cjs", {
        "/app/markdown-worker.mjs": `${worker}await import('./caught.cjs');\n`,
        "/app/caught.cjs": `try { ${operation}; } catch {} module.exports = 1;\n`,
      });
      const result = await run(f, wire());
      refused(result, true);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it.each(["format", "source", "throw", "transparent"])("checks actual delegated load results: %s", async (kind) => {
      const intervention =
        kind === "format"
          ? "return { ...result, format: 'commonjs' };"
          : kind === "source"
            ? "return { ...result, source: 'process.stderr.write(\"EXECUTED_UNVERIFIED\");' };"
            : kind === "throw"
              ? "throw new Error('source-secret');"
              : "return result;";
      const bootstrap = files
        .get("/app/markdown-bootstrap.mjs")!
        .toString()
        .replace(
          "    installGuard(policy);",
          `    registerHooks({ load(url, context, next) { const result = next(url, context); if (url === 'file:///app/markdown-inspection.mjs') { ${intervention} } return result; } });\n    installGuard(policy);`,
        );
      const f = await fixture(`delegated-load-${kind}`, { "/app/markdown-bootstrap.mjs": bootstrap });
      if (kind === "transparent") await accepted(f);
      else refused(await run(f, wire()));
    });

    it("disallows a cached builtin from a package even when that package catches it", async () => {
      const path = "/app/node_modules/mdurl/index.mjs";
      const f = await fixture("package-builtin", {
        [path]: `${files.get(path)!.toString()}\ntry { await import('node:crypto'); } catch {}\n`,
      });
      refused(await run(f, wire()));
    });

    it("requires the actual nearest nested dependency rather than an equal-name root", async () => {
      const nested = "/app/node_modules/markdown-it/node_modules/entities";
      const additions: Record<string, string> = {};
      for (const [path, bytes] of files) {
        if (path.startsWith(`${nested}/`))
          additions[path.replace(nested, "/app/node_modules/entities")] = bytes.toString();
      }
      const valid = await fixture("nearest-dependency", additions);
      await accepted(valid);
      const wrong = await fixture("wrong-nearest-dependency", additions, (policy) => {
        policy.packages
          .find((pkg) => pkg.name === "markdown-it")!
          .dependencies.find((dep) => dep.name === "entities")!.root = "/app/node_modules/entities";
      });
      refused(await run(wrong, wire()));
    });

    it("checks bounded no-follow reads with a builtins-only owned harness", () => {
      const source = files
        .get("/app/markdown-bootstrap.mjs")!
        .toString()
        .replace(/^import[\s\S]*?from "node:[^"]+";\n/gm, "")
        .replace(/^export /gm, "")
        .replaceAll("import.meta.url", JSON.stringify("file:///app/markdown-bootstrap.mjs"));
      const snapshot = { isFile: () => true, nlink: 1n, size: 4n, ino: 1n };
      const options: { size?: bigint; regular?: boolean; link?: boolean; changed?: boolean } = {};
      const opened: number[] = [],
        reads: number[] = [];
      let closed = 0,
        stats = 0;
      const harness = runInNewContext(`${source}\n({ readBounded });`, {
        Buffer,
        constants,
        process: { stdin: { destroy() {} }, stderr: { write() {} } },
        realpathSync: (path: string) => (options.link ? `${path}-target` : path),
        openSync: (_path: string, flags: number) => {
          opened.push(flags);
          return 123;
        },
        fstatSync: () => ({
          ...snapshot,
          size: options.size ?? 4n,
          isFile: () => options.regular !== false,
          ino: options.changed && ++stats > 1 ? 2n : 1n,
        }),
        closeSync: () => {
          closed++;
        },
        readSync: (_fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
          reads.push(length);
          if (position === 4) return 0;
          bytes.fill(120, offset, offset + length);
          return length;
        },
      }) as { readBounded(path: string, cap: number): Buffer };
      expect(harness.readBounded("/app/owned", 8)).toEqual(Buffer.from("xxxx"));
      expect(opened[0]! & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(opened[0]! & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      expect(closed).toBe(1);
      expect(reads).toEqual([4, 1]);
      options.size = 9n;
      expect(() => harness.readBounded("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
      expect(reads).toEqual([4, 1]);
      expect(closed).toBe(2);
      options.size = 4n;
      options.regular = false;
      expect(() => harness.readBounded("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
      expect(closed).toBe(3);
      options.regular = true;
      options.link = true;
      expect(() => harness.readBounded("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
      expect(opened.length).toBe(3);
      options.link = false;
      options.changed = true;
      expect(() => harness.readBounded("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
      expect(closed).toBe(4);
    });

    it("runs with exact read grants and the fixed closed-root environment", async () => {
      const checks = `
const expected = { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', UV_THREADPOOL_SIZE: '1', PWD: '/app' };
if (process.cwd() !== '/app' || Object.keys(process.env).length !== 5 || Object.entries(expected).some(([key, value]) => process.env[key] !== value)) throw new Error('fixture environment');
if (!process.permission.has('fs.read', '/app/markdown-inspection.mjs') || process.permission.has('fs.read', '/app') || process.permission.has('fs.read', '/etc/passwd')) throw new Error('fixture read grants');
for (const scope of ['fs.write', 'child', 'worker', 'addons']) if (process.permission.has(scope)) throw new Error('fixture grants');
`;
      await accepted(await fixture("exact-grants", { "/app/markdown-worker.mjs": `${noFetch}${worker}${checks}` }));
    });

    it("does not claim to interpose process.getBuiltinModule", async () => {
      const f = await fixture("builtin-limitation", {
        "/app/markdown-worker.mjs": `${worker}if (typeof process.getBuiltinModule('node:crypto').createHash !== 'function') throw new Error('fixture');\n`,
      });
      await accepted(f);
    });
  },
);
