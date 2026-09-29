import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostBatch } from "./batch.ts";
import type { ChangedFile } from "./change-validation.ts";
import type { CompletedHost, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { lockGitPublication } from "./git-publication-lock.ts";
import { DEFAULT_EXTERNAL_ROOT, EXTERNAL_BOUNDARY } from "./paths.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const environment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Publication fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Publication fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"])
  delete (environment as NodeJS.ProcessEnv)[name];

interface Internals {
  git(args: string[]): Buffer;
  verifyReady(): Promise<{ completed: CompletedHost }>;
  staged(tree: string, parent: string): Promise<ChangedFile[]>;
}
function internal(batch: HostBatch): Internals {
  return batch as unknown as Internals;
}
const producer: ProducerContext = {
  inputs_sha256: "c".repeat(64),
  runtime: { node: "26.8.1", icu: "78.3", unicode: "17.0", platform: "linux", arch: "x64" },
};
function completed(hostname: string): CompletedHost {
  const sourceUrl = `https://${hostname}/`;
  const title = `Public guidance for ${hostname}`;
  const body = "Public programme requirements and eligibility.\n";
  return {
    complete: true,
    host: {
      hostname,
      title,
      homepage_url: sourceUrl,
      homepage_retrieved_at: "2026-09-18T00:00:00.000Z",
      homepage_sha256: "e".repeat(64),
      scope: "Public text",
      document_root: `data/documents/${hostname}`,
      document_count: 1,
    },
    documents: [
      {
        id: `documents:official-web:${sha256(sourceUrl).slice(0, 24)}`,
        hostname,
        title,
        source_url: sourceUrl,
        retrieved_at: "2026-09-18T00:00:00.000Z",
        source_modified_at: null,
        snapshot_sha256: "e".repeat(64),
        input_sha256: "d".repeat(64),
        body_sha256: sha256(body),
        content_sha256: sha256(`${title}\n${body}`),
        content_markdown: body,
        warnings: [],
        alternate_urls: [],
        producer,
      },
    ],
  };
}

async function fixture() {
  const root = join(EXTERNAL_BOUNDARY, `batch-git-test-${randomUUID()}`);
  const repositoryRoot = join(root, "repository");
  await mkdir(join(repositoryRoot, "src/host-scrapers"), { recursive: true });
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) => {
    if (["push", "ls-remote", "fetch", "clone"].includes(args[0]!)) throw new Error("External Git forbidden");
    return execFileSync("git", ["--no-optional-locks", ...args], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  git(["init", "--template=", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repositoryRoot, "src/host-scrapers/generic-hosts.json"), "[]\n");
  git(["add", "."]);
  git(["commit", "-m", "fixture baseline"]);
  const baseline = git(["rev-parse", "HEAD"]).toString().trim();
  git(["checkout", "-b", "feat/prose-documents"]);
  git(["remote", "add", "origin", "https://github.com/Reodite/ubc-unified-data"]);
  const identity = join(repositoryRoot, ".git");
  const workspace = join(DEFAULT_EXTERNAL_ROOT, `git-publication-${sha256(identity)}`);
  const innerWorkspace = join(DEFAULT_EXTERNAL_ROOT, `host-publication-${sha256(repositoryRoot)}`);
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));
  cleanups.push(() => rm(innerWorkspace, { recursive: true, force: true }));
  const marker = join(workspace, "active-publication.json");
  let pushes = 0;
  let commits = 0;
  let beforePush: (() => void) | undefined;
  let afterCommit: (() => void) | undefined;
  const makeBatch = async (name: string, hostname = `${name}.ubc.ca`) => {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        repositoryRoot,
        producerRoot: join(directory, "producer"),
        producer,
        baseline,
        main: baseline,
        bootstrapFiles: {},
      }),
    );
    const batch = await HostBatch.open(directory);
    cleanups.push(() => batch.close());
    batch.seed([{ hostname, admitted: true }]);
    const { token } = (await batch.claim("w1"))!;
    batch.queue.update(hostname, token!, "collecting");
    batch.queue.update(hostname, token!, "ready", { documents: 1 });
    internal(batch).verifyReady = async () => ({ completed: completed(hostname) });
    internal(batch).git = (args) => {
      if (args[0] === "push") {
        expect(args).toEqual(["push", "origin", "HEAD:refs/heads/feat/prose-documents"]);
        pushes++;
        beforePush?.();
        return Buffer.alloc(0);
      }
      if (args[0] === "ls-remote")
        return Buffer.from(
          `${git(["rev-parse", "HEAD"]).toString().trim()}\trefs/heads/feat/prose-documents\n${baseline}\trefs/heads/main\n`,
        );
      const result = git(args);
      if (args[0] === "commit") {
        commits++;
        afterCommit?.();
      }
      return result;
    };
    return {
      batch,
      directory,
      hostname,
      token: token!,
      publish: () => batch.publish(hostname, token!, "Reviewed public guidance"),
    };
  };
  return {
    root,
    repositoryRoot,
    baseline,
    identity,
    workspace,
    marker,
    git,
    makeBatch,
    set beforePush(value: (() => void) | undefined) {
      beforePush = value;
    },
    set afterCommit(value: (() => void) | undefined) {
      afterCommit = value;
    },
    get pushes() {
      return pushes;
    },
    get commits() {
      return commits;
    },
  };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("repository-wide Git publication", () => {
  it("fails fast for a second batch while the first awaits after its staged snapshot", async () => {
    const f = await fixture();
    const a = await f.makeBatch("batch-a");
    const b = await f.makeBatch("batch-b");
    const verify = internal(a.batch).verifyReady.bind(a.batch);
    internal(a.batch).verifyReady = async () => {
      expect(() => lockGitPublication(f.repositoryRoot, f.identity)).toThrow(
        "Git publication lock is held or unavailable",
      );
      return verify();
    };
    f.beforePush = () => {
      expect(() => lockGitPublication(f.repositoryRoot, f.identity)).toThrow(
        "Git publication lock is held or unavailable",
      );
    };
    const captured = barrier();
    const resume = barrier();
    const staged = internal(a.batch).staged.bind(a.batch);
    internal(a.batch).staged = async (...args) => {
      const files = await staged(...args);
      captured.release();
      await resume.promise;
      return files;
    };
    const publishing = a.publish();
    try {
      await captured.promise;
      const tree = f.git(["write-tree"]).toString();
      await expect(b.publish()).rejects.toThrow("Git publication lock is held or unavailable");
      expect(f.git(["write-tree"]).toString()).toBe(tree);
      expect(b.batch.queue.get(b.hostname)?.state).toBe("ready");
      expect(f.commits).toBe(0);
    } finally {
      resume.release();
    }
    await publishing;
    const first = f.git(["rev-parse", "HEAD"]).toString().trim();
    expect(f.git(["show", "--format=", "--name-only", first]).toString()).not.toContain(b.hostname);
    await b.publish();
    expect(f.commits).toBe(2);
    expect(f.pushes).toBe(2);
    expect(f.git(["status", "--porcelain"]).length).toBe(0);
  });

  it.each(["different-host", "same-host"])(
    "retains the durable fence against a %s batch after interrupted push",
    async (mode) => {
      const f = await fixture();
      const a = await f.makeBatch("batch-a");
      const b = await f.makeBatch("batch-b", mode === "same-host" ? a.hostname : "batch-b.ubc.ca");
      f.beforePush = () => {
        throw new Error("uncertain push");
      };
      await expect(a.publish()).rejects.toThrow("uncertain push");
      const original = await readFile(f.marker);
      expect(JSON.parse(original.toString())).toMatchObject({
        batch_directory: a.directory,
        hostname: a.hostname,
        token: a.token,
      });
      await expect(b.publish()).rejects.toThrow("Another batch or claim has an unfinished Git publication");
      expect(await readFile(f.marker)).toEqual(original);
      expect(f.commits).toBe(1);
      expect(f.pushes).toBe(1);
      f.beforePush = undefined;
      await a.publish();
      expect(f.commits).toBe(1);
      expect(f.pushes).toBe(2);
      await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["batch_directory", "hostname", "token"] as const)(
    "binds the durable fence's %s independently",
    async (field) => {
      const f = await fixture();
      const a = await f.makeBatch("batch-a");
      const owner = { batch_directory: a.directory, hostname: a.hostname, token: a.token };
      const lock = lockGitPublication(f.repositoryRoot, f.identity);
      await lock.claim(owner);
      lock.close();
      const next = lockGitPublication(f.repositoryRoot, f.identity);
      try {
        const values = {
          batch_directory: join(f.root, "different-batch"),
          hostname: "different.ubc.ca",
          token: randomUUID(),
        };
        await expect(next.claim({ ...owner, [field]: values[field] })).rejects.toThrow("Another batch or claim");
      } finally {
        next.close();
      }
      await a.publish();
    },
  );

  it("recovers the exact committed tree after interruption before the commit receipt", async () => {
    const f = await fixture();
    const a = await f.makeBatch("batch-a");
    const b = await f.makeBatch("batch-b");
    f.afterCommit = () => {
      throw new Error("crash after commit");
    };
    await expect(a.publish()).rejects.toThrow("crash after commit");
    const receipt = JSON.parse(await readFile(join(a.directory, "publications", `${a.hostname}.json`), "utf8"));
    expect(receipt.tree).toBe(f.git(["rev-parse", "HEAD^{tree}"]).toString().trim());
    expect(receipt.commit).toBeUndefined();
    await expect(b.publish()).rejects.toThrow("Another batch or claim");
    f.afterCommit = undefined;
    await a.publish();
    expect(f.commits).toBe(1);
    expect(f.pushes).toBe(1);
  });

  it("reconciles a published queue receipt if cleanup was interrupted", async () => {
    const f = await fixture();
    const a = await f.makeBatch("batch-a");
    const b = await f.makeBatch("batch-b");
    const update = a.batch.queue.update.bind(a.batch.queue);
    a.batch.queue.update = (...args) => {
      update(...args);
      if (args[2] === "published") throw new Error("crash after queue receipt");
    };
    await expect(a.publish()).rejects.toThrow("crash after queue receipt");
    expect(a.batch.queue.get(a.hostname)?.state).toBe("published");
    await expect(b.publish()).rejects.toThrow("Another batch or claim");
    a.batch.queue.update = update;
    await a.publish();
    expect(f.commits).toBe(1);
    await b.publish();
    expect(f.commits).toBe(2);
  });

  it.each(["same", "different", "owner-pause"])(
    "handles an own-batch %s legacy marker without discarding a different fence",
    async (mode) => {
      const f = await fixture();
      const a = await f.makeBatch("batch-a");
      const legacy = join(a.directory, "state", "active-publication.json");
      const bytes = JSON.stringify({
        hostname: mode === "different" ? "another.ubc.ca" : a.hostname,
        ...(mode === "owner-pause" ? { owner_pause: true } : {}),
      });
      await writeFile(legacy, bytes);
      if (mode === "same") {
        await a.publish();
        await expect(readFile(legacy)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(a.publish()).rejects.toThrow(/legacy publication/);
        expect(await readFile(legacy, "utf8")).toBe(bytes);
        expect(f.commits).toBe(0);
        await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("rejects staged changes after the validated snapshot without recording them as the receipt tree", async () => {
    const f = await fixture();
    const a = await f.makeBatch("batch-a");
    const staged = internal(a.batch).staged.bind(a.batch);
    let snapshot = "";
    internal(a.batch).staged = async (tree, parent) => {
      snapshot = tree;
      const files = await staged(tree, parent);
      await writeFile(join(f.repositoryRoot, "unauthorized.txt"), "not part of the validated host\n");
      f.git(["add", "unauthorized.txt"]);
      return files;
    };
    await expect(a.publish()).rejects.toThrow("Git index changed after staged tree validation");
    const receipt = JSON.parse(await readFile(join(a.directory, "publications", `${a.hostname}.json`), "utf8"));
    expect(receipt.tree).toBe(snapshot);
    expect(receipt.tree).not.toBe(f.git(["write-tree"]).toString().trim());
    expect(f.commits).toBe(0);
    expect(f.pushes).toBe(0);
  });

  it.each(["commit hook", "external index writer"])(
    "does not receipt, push or mark published a %s's unvalidated committed tree",
    async (writer) => {
      const f = await fixture();
      const a = await f.makeBatch("batch-a");
      if (writer === "commit hook") {
        await mkdir(join(f.identity, "hooks"));
        await writeFile(
          join(f.identity, "hooks", "pre-commit"),
          '#!/bin/sh\nprintf "unexpected\\n" > unauthorized.txt\ngit add unauthorized.txt\n',
          { mode: 0o700 },
        );
      } else {
        const git = internal(a.batch).git.bind(a.batch);
        internal(a.batch).git = (args) => {
          // The index changes after the final write-tree check but before Git starts the commit.
          if (args[0] === "commit") {
            writeFileSync(join(f.repositoryRoot, "unauthorized.txt"), "unexpected\n");
            f.git(["add", "unauthorized.txt"]);
          }
          return git(args);
        };
      }
      await expect(a.publish()).rejects.toThrow("Committed tree or parent differs from validated stage");
      const receipt = JSON.parse(await readFile(join(a.directory, "publications", `${a.hostname}.json`), "utf8"));
      expect(receipt.commit).toBeUndefined();
      expect(receipt.pushed).toBeUndefined();
      expect(receipt.tree).not.toBe(f.git(["rev-parse", "HEAD^{tree}"]).toString().trim());
      expect(f.git(["show", "HEAD:unauthorized.txt"]).toString()).toBe("unexpected\n");
      expect(a.batch.queue.get(a.hostname)?.state).toBe("publishing");
      const marker = await readFile(f.marker);
      expect(JSON.parse(marker.toString())).toMatchObject({
        batch_directory: a.directory,
        hostname: a.hostname,
        token: a.token,
      });
      await expect(a.publish()).rejects.toThrow("Unrecognized HEAD after interrupted commit");
      expect(a.batch.queue.get(a.hostname)?.state).toBe("publishing");
      expect(await readFile(f.marker)).toEqual(marker);
      expect(f.commits).toBe(1);
      expect(f.pushes).toBe(0);
    },
  );

  it("keys aliases to the same physical Git directory and preserves private permissions", async () => {
    const f = await fixture();
    const a = await f.makeBatch("batch-a");
    const alias = join(f.root, "git-alias");
    await symlink(f.identity, alias);
    const lock = lockGitPublication(f.repositoryRoot, f.identity);
    try {
      await lock.claim({ batch_directory: a.directory, hostname: a.hostname, token: a.token });
      expect(() => lockGitPublication(f.repositoryRoot, alias)).toThrow("Git publication lock is held or unavailable");
      expect((await stat(f.workspace)).mode & 0o777).toBe(0o700);
      expect((await stat(join(f.workspace, "lock.sqlite"))).mode & 0o777).toBe(0o600);
      expect((await stat(f.marker)).mode & 0o777).toBe(0o600);
    } finally {
      lock.close();
    }
  });

  it("rejects batch paths outside the external boundary or inside the repository", async () => {
    const f = await fixture();
    const lock = lockGitPublication(f.repositoryRoot, f.identity);
    try {
      for (const batch_directory of ["/tmp/unowned-batch", f.repositoryRoot])
        await expect(lock.claim({ batch_directory, hostname: "batch-a.ubc.ca", token: randomUUID() })).rejects.toThrow(
          "Path must stay external",
        );
      await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      lock.close();
    }
  });

  it.each(["workspace", "lock", "journal", "shared-marker", "legacy-marker"])(
    "rejects a symlink at the %s boundary",
    async (target) => {
      const f = await fixture();
      const a = await f.makeBatch("batch-a");
      const victim = join(f.root, "victim");
      await writeFile(victim, "preserved");
      if (target === "workspace") {
        await symlink(f.root, f.workspace);
      } else {
        await mkdir(f.workspace, { recursive: true });
        const path =
          target === "lock"
            ? join(f.workspace, "lock.sqlite")
            : target === "journal"
              ? join(f.workspace, "lock.sqlite-journal")
              : target === "legacy-marker"
                ? join(a.directory, "state", "active-publication.json")
                : f.marker;
        await symlink(victim, path);
      }
      await expect(a.publish()).rejects.toThrow(/Symlink/);
      expect(await readFile(victim, "utf8")).toBe("preserved");
      expect(f.commits).toBe(0);
    },
  );

  it("releases the process lock on child death but retains its durable batch fence", async () => {
    const f = await fixture();
    const a = await f.makeBatch("batch-a");
    const b = await f.makeBatch("batch-b", a.hostname);
    const helper = new URL("./git-publication-lock.ts", import.meta.url).href;
    const script = `import { lockGitPublication } from ${JSON.stringify(helper)};
const lock = lockGitPublication(${JSON.stringify(f.repositoryRoot)}, ${JSON.stringify(f.identity)});
await lock.claim(${JSON.stringify({ batch_directory: a.directory, hostname: a.hostname, token: a.token })});
process.stdout.write("locked\\n");
setInterval(() => {}, 1000);`;
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    let stderr = "";
    child.stderr.on("data", (bytes) => {
      stderr += bytes.toString();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
        exited.then(() => {
          throw new Error(`Child exited before lock: ${stderr}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Child lock timeout: ${stderr}`)), 10_000);
        }),
      ]);
      await expect(b.publish()).rejects.toThrow("Git publication lock is held or unavailable");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await exited;
    }
    await expect(b.publish()).rejects.toThrow("Another batch or claim");
    await a.publish();
    expect(f.commits).toBe(1);
    expect(f.pushes).toBe(1);
  });
});
