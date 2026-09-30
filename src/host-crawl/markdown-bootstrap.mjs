import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isBuiltin, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const POLICY_PATH = "/app/markdown-guard-policy.json";
const POLICY_BYTES = 1048576;
const FILE_BYTES = 8388608;
const APP_BYTES = 33554432;
const FILES = 512;
const DIRECTORIES = 128;
const BUILTINS = [
  {
    parent: "/app/markdown-bootstrap.mjs",
    allowed: ["node:crypto", "node:fs", "node:module", "node:url", "node:util"],
  },
  { parent: "/app/markdown-contract.mjs", allowed: [] },
  { parent: "/app/markdown-inspection.mjs", allowed: ["node:crypto", "node:util"] },
  { parent: "/app/markdown-protocol.mjs", allowed: ["node:buffer", "node:crypto", "node:util"] },
  { parent: "/app/markdown-worker.mjs", allowed: [] },
];
let violated = false;
let started = false;
let refused = false;

function deny() {
  refuse();
  throw new Error("MARKDOWN_WORKER_REFUSED");
}

function clean() {
  if (violated) deny();
}

function refuse() {
  violated = true;
  process.exitCode = 1;
  process.stdin.destroy();
  if (!refused) {
    refused = true;
    process.stderr.write("MARKDOWN_WORKER_REFUSED\n");
  }
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBounded(path, cap) {
  if (realpathSync(path) !== path) deny();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(cap)) deny();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) deny();
      offset += count;
    }
    if (offset < cap && readSync(fd, Buffer.alloc(1), 0, 1, offset)) deny();
    const after = fstatSync(fd, { bigint: true });
    for (const field of ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeNs", "ctimeNs"]) {
      if (before[field] !== after[field]) deny();
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function record(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) deny();
}

function list(value, cap) {
  if (!Array.isArray(value) || value.length > cap) deny();
}

function text(value, cap) {
  if (typeof value !== "string" || !value.length || value.length > cap || /[^\x20-\x7e]/.test(value)) deny();
}

function pathField(path) {
  if (typeof path !== "string" || !path.startsWith("/app")) deny();
  const parts = path.slice(1).split("/");
  if (parts[0] !== "app" || parts.length > 16) deny();
  for (const part of parts) {
    if (!/^[a-zA-Z0-9._@+-]{1,255}$/.test(part) || part === "." || part === "..") deny();
  }
}

function nameField(name) {
  text(name, 511);
  if (!/^(?:@[a-zA-Z0-9_+-][a-zA-Z0-9._+-]*\/)?[a-zA-Z0-9_+-][a-zA-Z0-9._+-]*$/.test(name)) deny();
  if (name.split("/").some((part) => part.length > 255) || isBuiltin(name)) deny();
}

function sorted(values, key) {
  for (let index = 1; index < values.length; index++) {
    if (values[index - 1][key] >= values[index][key]) deny();
  }
}

function owner(packages, path) {
  let found;
  for (const pkg of packages) {
    if (path.startsWith(`${pkg.root}/`) && (!found || pkg.root.length > found.root.length)) found = pkg;
  }
  return found;
}

function nearest(packages, directory, name) {
  for (
    let cursor = directory;
    cursor === "/app" || cursor.startsWith("/app/");
    cursor = cursor.slice(0, cursor.lastIndexOf("/"))
  ) {
    if (cursor.endsWith("/node_modules")) continue;
    const root = `${cursor}/node_modules/${name}`;
    if (packages.some((pkg) => pkg.root === root)) return root;
  }
}

function expectedFormat(path, pkg) {
  if (path.endsWith(".mjs")) return "module";
  if (path.endsWith(".cjs")) return "commonjs";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".js")) return pkg.type;
  return "data";
}

function validatePolicy(bytes) {
  const policy = JSON.parse(bytes.toString("utf8"));
  record(policy, ["version", "files", "packages", "builtins"]);
  if (policy.version !== 1) deny();
  list(policy.files, FILES);
  list(policy.packages, DIRECTORIES);
  list(policy.builtins, BUILTINS.length);
  const packages = policy.packages.map((pkg) => {
    record(pkg, ["root", "name", "version", "type", "dependencies"]);
    pathField(pkg.root);
    nameField(pkg.name);
    text(pkg.version, 255);
    if (!["module", "commonjs"].includes(pkg.type)) deny();
    list(pkg.dependencies, FILES);
    const dependencies = pkg.dependencies.map((dep) => {
      record(dep, ["name", "range", "root"]);
      nameField(dep.name);
      text(dep.range, 255);
      pathField(dep.root);
      return { name: dep.name, range: dep.range, root: dep.root };
    });
    sorted(dependencies, "name");
    return { root: pkg.root, name: pkg.name, version: pkg.version, type: pkg.type, dependencies };
  });
  sorted(packages, "root");
  const app = packages[0];
  if (app?.root !== "/app" || app.name !== "ubc-markdown-runtime" || app.version !== "1.0.0" || app.type !== "module")
    deny();
  if (app.dependencies.length !== 1 || app.dependencies[0].name !== "markdown-it") deny();
  for (const pkg of packages) {
    if (pkg !== app) {
      const suffix = `/node_modules/${pkg.name}`;
      if (!pkg.root.endsWith(suffix) || !packages.some((parent) => parent.root === pkg.root.slice(0, -suffix.length)))
        deny();
    }
    for (const dep of pkg.dependencies) {
      if (!packages.some((target) => target.root === dep.root && target.name === dep.name)) deny();
      if (nearest(packages, pkg.root, dep.name) !== dep.root) deny();
    }
  }
  const directories = new Set();
  const files = policy.files.map((file) => {
    record(file, ["path", "sha256", "format"]);
    pathField(file.path);
    if (
      file.path === "/app" ||
      file.path === POLICY_PATH ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      deny();
    const pkg = owner(packages, file.path);
    if (!pkg || expectedFormat(file.path, pkg) !== file.format) deny();
    const local = file.path.slice(pkg.root.length + 1);
    if (local.split("/").includes("node_modules")) deny();
    if (file.path.endsWith("/package.json") && file.path !== `${pkg.root}/package.json`) deny();
    for (
      let directory = file.path.slice(0, file.path.lastIndexOf("/"));
      directory;
      directory = directory.slice(0, directory.lastIndexOf("/"))
    ) {
      directories.add(directory);
    }
    return { path: file.path, sha256: file.sha256, format: file.format };
  });
  sorted(files, "path");
  if (directories.size > DIRECTORIES || files.some((file) => directories.has(file.path))) deny();
  const inventory = new Map(files.map((file) => [file.path, file]));
  for (const entry of BUILTINS) {
    if (inventory.get(entry.parent)?.format !== "module") deny();
  }
  const builtins = policy.builtins.map((entry) => {
    record(entry, ["parent", "allowed"]);
    return { parent: entry.parent, allowed: entry.allowed };
  });
  if (JSON.stringify(builtins) !== JSON.stringify(BUILTINS)) deny();
  // Canonical reconstruction also rejects duplicate JSON keys and malformed UTF-8.
  if (!Buffer.from(JSON.stringify({ version: 1, files, packages, builtins })).equals(bytes)) deny();
  return {
    files: inventory,
    packages,
    builtins: new Map(BUILTINS.map((entry) => [entry.parent, new Set(entry.allowed)])),
  };
}

function verifyInventory(policy) {
  let total = 0;
  for (const [path, entry] of policy.files) {
    const bytes = readBounded(path, FILE_BYTES);
    total += bytes.length;
    if (total > APP_BYTES || hash(bytes) !== entry.sha256) deny();
    if (!path.endsWith("/package.json")) continue;
    const pkg = policy.packages.find((item) => path === `${item.root}/package.json`);
    if (!pkg) deny();
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.name !== pkg.name || manifest.version !== pkg.version || (manifest.type ?? "commonjs") !== pkg.type)
      deny();
    for (const key of [
      "imports",
      "optionalDependencies",
      "peerDependencies",
      "bundledDependencies",
      "bundleDependencies",
    ]) {
      if (Object.hasOwn(manifest, key)) deny();
    }
    const dependencies = manifest.dependencies ?? {};
    record(
      dependencies,
      pkg.dependencies.map((dep) => dep.name),
    );
    if (pkg.dependencies.some((dep) => dependencies[dep.name] !== dep.range)) deny();
  }
  if (policy.packages.some((pkg) => !policy.files.has(`${pkg.root}/package.json`))) deny();
}

function installGuard(policy) {
  const builtinLoads = new Set();
  function local(url) {
    if (typeof url !== "string" || !url.startsWith("file:")) deny();
    const parsed = new URL(url);
    if (parsed.host || parsed.search || parsed.hash) deny();
    const path = fileURLToPath(parsed);
    if (pathToFileURL(path).href !== url || !policy.files.has(path)) deny();
    return path;
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        clean();
        const parent = local(context.parentURL);
        if (isBuiltin(specifier)) {
          const name = specifier.startsWith("node:") ? specifier : `node:${specifier}`;
          if (!policy.builtins.get(parent)?.has(name)) deny();
          const result = nextResolve(specifier, context);
          if (result.url !== name || (result.format !== undefined && result.format !== "builtin")) deny();
          builtinLoads.add(name);
          return result;
        }
        const from = owner(policy.packages, parent);
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        let expected = from.root;
        if (relative) {
          if (!/^[a-zA-Z0-9._@+/-]+$/.test(specifier)) deny();
        } else {
          const parts = specifier.split("/");
          const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
          nameField(name);
          if (parts.some((part) => !/^[a-zA-Z0-9._@+-]+$/.test(part) || part === "." || part === "..")) deny();
          if (name !== from.name) {
            const declared = from.dependencies.find((dep) => dep.name === name);
            if (!declared) deny();
            expected = nearest(policy.packages, parent.slice(0, parent.lastIndexOf("/")), name);
            if (expected !== declared.root) deny();
          }
        }
        const result = nextResolve(specifier, context);
        const target = local(result.url);
        const entry = policy.files.get(target);
        if (owner(policy.packages, target)?.root !== expected || entry.format === "data") deny();
        // CJS resolution can leave format unset; load must still establish it exactly.
        if (result.format != null && result.format !== entry.format) deny();
        return result;
      } catch {
        deny();
      }
    },
    load(url, context, nextLoad) {
      try {
        clean();
        if (url.startsWith("node:")) {
          if (!builtinLoads.has(url)) deny();
          const result = nextLoad(url, context);
          if (result.format !== "builtin") deny();
          return result;
        }
        const path = local(url);
        const entry = policy.files.get(path);
        if (entry.format === "data" || hash(readBounded(path, FILE_BYTES)) !== entry.sha256) deny();
        if (context.format != null && context.format !== entry.format) deny();
        // CJS preparse leaves format unset; supply the independently derived inventory format.
        const result = nextLoad(url, { ...context, format: entry.format });
        if (result.format !== entry.format || result.source == null || hash(result.source) !== entry.sha256) deny();
        return result;
      } catch {
        deny();
      }
    },
  });
}

/** Run the sole metadata-only child path; invocation and projection belong to the trusted parent. */
export async function runMarkdownWorker() {
  process.on("uncaughtException", refuse);
  process.on("unhandledRejection", refuse);
  process.stdin.on("error", refuse);
  process.stdout.on("error", refuse);
  process.stderr.on("error", () => {
    process.exitCode = 1;
  });
  // A frame is only a candidate: caught late hook failures must still fail process completion.
  process.on("beforeExit", () => {
    if (violated) refuse();
  });
  process.on("exit", () => {
    if (violated) process.exitCode = 1;
  });
  try {
    if (started) deny();
    started = true;
    if (
      process.argv.length !== 3 ||
      process.argv[1] !== "/app/markdown-worker.mjs" ||
      process.cwd() !== "/app" ||
      import.meta.url !== "file:///app/markdown-bootstrap.mjs"
    )
      deny();
    const digest = process.argv[2];
    if (!/^[a-f0-9]{64}$/.test(digest)) deny();
    const bytes = readBounded(POLICY_PATH, POLICY_BYTES);
    if (hash(bytes) !== digest) deny();
    const policy = validatePolicy(bytes);
    verifyInventory(policy);
    // Cache hits and process.getBuiltinModule are not universally interposed; code is fixed and trusted.
    installGuard(policy);
    const codec = await import("./markdown-protocol.mjs");
    const decoder = codec.createMarkdownRequestDecoder();
    let count = 0;
    for await (const chunk of process.stdin) {
      count += chunk.length;
      if (count > codec.MARKDOWN_PROTOCOL_LIMITS.requestFrameBytes) deny();
      decoder.push(chunk);
    }
    const request = decoder.finish();
    const input = codec.getMarkdownRequestInput(request);
    const { inspectMarkdownSource } = await import("./markdown-inspection.mjs");
    const inspection = inspectMarkdownSource(input.bytes, input.advertised_titles);
    clean();
    const response = codec.encodeMarkdownResponse(inspection, request);
    clean();
    await new Promise((resolve, reject) => {
      process.stdout.end(response, (error) => (error ? reject(error) : resolve()));
    });
    clean();
  } catch {
    refuse();
  }
}
