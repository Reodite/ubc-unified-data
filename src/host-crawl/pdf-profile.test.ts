import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { open, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import {
  assertPdfProfile,
  capturePdfProfile,
  createPdfWorkspace,
  PDF_EXECUTABLES,
  PDF_LIMITS,
  PDF_TEXT_ARGUMENTS,
  PdfEvidenceError,
  requirePdfProfile,
  runPdfNative,
} from "./pdf-profile.ts";

const fake = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  links: new Map<string, string>(),
  missing: new Set<string>(),
  version: "synthetic version 1",
  help: "",
  mode: "normal",
  killed: false,
}));

vi.mock("node:fs/promises", () => {
  const resolved = (path: string): string => fake.links.get(path) ?? path;
  const info = (path: string, follow: boolean) => {
    if (fake.missing.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    const target = follow ? resolved(path) : path;
    return {
      dev: 1,
      ino: 1,
      size: fake.files.get(target)?.length ?? 0,
      mtimeMs: 1,
      ctimeMs: 1,
      isSymbolicLink: () => !follow && fake.links.has(path),
      isFile: () => fake.files.has(target),
      isDirectory: () => !fake.files.has(target) && (follow || !fake.links.has(path)),
    };
  };
  return {
    lstat: vi.fn(async (path: string) => info(path, false)),
    stat: vi.fn(async (path: string) => info(path, true)),
    realpath: vi.fn(async (path: string) => resolved(path)),
    readlink: vi.fn(async (path: string) => fake.links.get(path)),
    readdir: vi.fn(async (path: string) =>
      [...fake.files.keys(), ...fake.links.keys()]
        .filter((name) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes("/"))
        .map((name) => name.slice(path.length + 1)),
    ),
    open: vi.fn(async (path: string) => {
      let offset = 0;
      return {
        stat: async () => info(path, true),
        read: async (buffer: Buffer) => {
          const bytes = fake.files.get(path)!;
          const count = bytes.copy(buffer, 0, offset, offset + buffer.length);
          offset += count;
          return { bytesRead: count };
        },
        close: vi.fn(async () => {}),
      };
    }),
    mkdir: vi.fn(async () => {}),
    mkdtemp: vi.fn(async (prefix: string) => `${prefix}private`),
    writeFile: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn((_executable: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        fake.killed = true;
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      }),
    });
    queueMicrotask(() => {
      if (fake.mode === "hold") {
        child.stdout.emit("data", Buffer.from("partial output"));
        child.stderr.emit("data", Buffer.from("partial diagnostic"));
        return;
      }
      if (fake.mode === "spawn-error") {
        child.emit("error", new Error("private native details"));
        child.emit("close", -2, null);
        return;
      }
      if (fake.mode === "nonzero") {
        child.stderr.emit("data", Buffer.from("private native details"));
        child.emit("close", 1, null);
        return;
      }
      if (fake.mode === "output") child.stdout.emit("data", Buffer.from("123456789"));
      else if (fake.mode === "diagnostics") child.stderr.emit("data", Buffer.alloc(256 * 1024 + 1));
      else if (args.includes("--list"))
        child.stdout.emit(
          "data",
          Buffer.from(
            "linux-vdso.so.1 (0x123)\nlibnative.so.1 => /usr/lib/libnative.so.1 (0x234)\n/lib64/ld-linux-x86-64.so.2 (0x345)\n",
          ),
        );
      else if (args.includes("-h")) child.stderr.emit("data", Buffer.from(fake.help));
      else child.stdout.emit("data", Buffer.from(fake.version));
      child.emit("close", 0, null);
    });
    return child;
  }),
}));

const workspace = `${DEFAULT_EXTERNAL_ROOT}/test-pdf-profile`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  fake.mode = "normal";
  fake.killed = false;
  fake.version = "synthetic version 1";
  fake.help =
    "Usage: pdftotext [options] <PDF-file> [<text-file>]\n  -layout : maintain original physical layout\n  -remove-hyphens <string>: end-of-line hyphen handling: none, soft, or all (default: all)\n";
  vi.mocked(writeFile).mockReset().mockResolvedValue();
  fake.files = new Map([
    ...Object.values(PDF_EXECUTABLES).map((path) => [path, Buffer.from(`executable ${path}`)] as const),
    ["/usr/lib/libnative.so.1.0", Buffer.from("library bytes")],
    ["/usr/share/fonts/font.ttf", Buffer.from("font bytes")],
    ["/etc/fonts/fonts.conf", Buffer.from("config bytes")],
    ["/etc/ld.so.cache", Buffer.from("loader cache")],
  ]);
  fake.links = new Map([["/usr/lib/libnative.so.1", "/usr/lib/libnative.so.1.0"]]);
  fake.missing = new Set([
    "/etc/poppler",
    "/usr/share/poppler",
    "/usr/local/share/poppler",
    "/usr/local/share/fonts",
    "/etc/ld.so.preload",
  ]);
});

describe("PDF dependency profile", () => {
  it("does not claim complete evidence after partial profile cleanup fails", async () => {
    vi.mocked(rm).mockRejectedValueOnce(new Error("Partial cleanup failed"));
    await expect(capturePdfProfile(workspace)).rejects.toMatchObject({
      name: "PdfEvidenceError",
      evidenceComplete: false,
    });
  });
  it("records streamed files, resolved library links, missing roots and extraction inputs", async () => {
    const profile = await capturePdfProfile(workspace);
    expect(profile.sha256).toMatch(/^[a-f\d]{64}$/);
    expect(profile.manifest.resources).toContainEqual({ path: "/usr/share/poppler", kind: "missing" });
    expect(profile.manifest.resources).toContainEqual({
      path: "/usr/lib/libnative.so.1",
      kind: "symlink",
      target: "/usr/lib/libnative.so.1.0",
      resolvedPath: "/usr/lib/libnative.so.1.0",
    });
    expect(profile.manifest.resources.find((row) => row.path === "/usr/share/fonts/font.ttf")).toMatchObject({
      kind: "file",
      bytes: 10,
      sha256: expect.stringMatching(/^[a-f\d]{64}$/),
    });
    expect(profile.manifest.extraction.textArguments).toContain("-layout");
    expect(profile.manifest.extraction.textArguments).not.toContain("-nopgbrk");
    expect(profile.manifest.extraction.environment).toMatchObject({ LC_ALL: "C", LANG: "C", TZ: "UTC" });
    expect(profile.manifest.extraction.fontconfig).not.toContain("<include");
    expect(Object.isFrozen(profile.manifest.resources)).toBe(true);
    expect(() => requirePdfProfile(profile)).not.toThrow();
    expect(open).toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith(`${workspace}/.pdf-private`, { recursive: true, force: true });
  });

  it.each([true, false])(
    "binds help evidence and capability-selected arguments (option available: %s)",
    async (available) => {
      if (!available) fake.help = fake.help.replace(/^.*-remove-hyphens.*\n/m, "");
      const profile = await capturePdfProfile(workspace);
      expect(profile.manifest.capabilities).toEqual({
        pdftotextHelp: { arguments: ["-h"], stdout: "", stderr: fake.help },
        removeHyphens: available ? "explicit-none" : "legacy-layout",
      });
      expect(profile.manifest.extraction.textArguments).toEqual(
        available ? [...PDF_TEXT_ARGUMENTS, "-remove-hyphens", "none"] : [...PDF_TEXT_ARGUMENTS],
      );
      expect(spawn).toHaveBeenCalledWith(
        PDF_EXECUTABLES.limits,
        expect.arrayContaining([PDF_EXECUTABLES.text, "-h"]),
        expect.objectContaining({ shell: false, env: expect.objectContaining({ LC_ALL: "C", TZ: "UTC" }) }),
      );
      fake.help += "Additional trusted help evidence\n";
      await expect(assertPdfProfile(profile, workspace)).rejects.toThrow("dependency profile changed");
    },
  );

  it("does not mistake similarly named options for hyphen-preservation support", async () => {
    fake.help = fake.help.replace("-remove-hyphens ", "-remove-hyphens-unsupported ");
    const profile = await capturePdfProfile(workspace);
    expect(profile.manifest.capabilities.removeHyphens).toBe("legacy-layout");
    expect(profile.manifest.extraction.textArguments).not.toContain("-remove-hyphens");
  });

  it.each(["not help", "Usage: pdftotext\n  -layout text\n  -remove-hyphens <string>: all only\n"])(
    "rejects unrecognized capability evidence and retains its private context",
    async (help) => {
      fake.help = help;
      const failure = await capturePdfProfile(workspace).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(PdfEvidenceError);
      expect((failure as PdfEvidenceError).evidenceDirectory).toBe(`${workspace}/.pdf-private`);
      expect(rm).not.toHaveBeenCalled();
      expect(writeFile).toHaveBeenCalledWith(`${workspace}/.pdf-private/failure.json`, expect.any(Buffer), {
        flag: "wx",
        mode: 0o600,
      });
    },
  );

  it("hashes fonts larger than its read buffer without materializing whole files", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, "f");
    fake.files.set("/usr/share/fonts/font.ttf", bytes);
    const profile = await capturePdfProfile(workspace);
    const { createHash } = await import("node:crypto");
    expect(profile.manifest.resources.find((row) => row.path === "/usr/share/fonts/font.ttf")).toMatchObject({
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("reproduces profiles despite locale, timezone and unrelated injected variables", async () => {
    const first = await capturePdfProfile(workspace);
    vi.stubEnv("LANG", "fr_CA.UTF-8");
    vi.stubEnv("TZ", "Pacific/Honolulu");
    vi.stubEnv("LD_PRELOAD", "/untrusted.so");
    try {
      const second = await capturePdfProfile(workspace);
      expect(second).toEqual(first);
      const options = vi.mocked(spawn).mock.calls.at(-1)![2]!;
      expect(options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"] });
      expect(options.env).toMatchObject({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
      expect(options.env).not.toHaveProperty("LD_PRELOAD");
      expect(options.env).not.toHaveProperty("PATH");
      expect(Object.values(options.env!).filter((value) => value?.includes(".pdf-private")).length).toBeGreaterThan(5);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "/usr/bin/pdfinfo",
    "/usr/bin/pdftotext",
    "/usr/bin/prlimit",
    "/lib64/ld-linux-x86-64.so.2",
    "/usr/lib/libnative.so.1.0",
    "/usr/share/fonts/font.ttf",
    "/etc/fonts/fonts.conf",
    "/etc/ld.so.cache",
  ])("rejects changed dependency bytes: %s", async (path) => {
    const profile = await capturePdfProfile(workspace);
    fake.files.set(path, Buffer.from("changed dependency"));
    await expect(assertPdfProfile(profile, workspace)).rejects.toThrow("dependency profile changed");
    expect(() => requirePdfProfile(profile)).toThrow("Capture or assert");
  });

  it("detects additions beneath a previously missing resource root", async () => {
    const profile = await capturePdfProfile(workspace);
    fake.missing.delete("/usr/share/poppler");
    fake.files.set("/usr/share/poppler/resource", Buffer.from("new resource"));
    await expect(assertPdfProfile(profile, workspace)).rejects.toThrow("dependency profile changed");
  });

  it("detects symlink retargeting and executable version changes", async () => {
    const profile = await capturePdfProfile(workspace);
    fake.files.set("/usr/lib/libnative.so.2.0", Buffer.from("library bytes"));
    fake.links.set("/usr/lib/libnative.so.1", "/usr/lib/libnative.so.2.0");
    await expect(assertPdfProfile(profile, workspace)).rejects.toThrow("dependency profile changed");
    fake.links.set("/usr/lib/libnative.so.1", "/usr/lib/libnative.so.1.0");
    fake.version = "synthetic version 2";
    await expect(assertPdfProfile(profile, workspace)).rejects.toThrow("dependency profile changed");
  });

  it("checks serialized profiles before extraction and rejects digest tampering cheaply", async () => {
    const profile = await capturePdfProfile(workspace);
    const restored = structuredClone(profile);
    expect(() => requirePdfProfile(restored)).toThrow("Capture or assert");
    await assertPdfProfile(restored, workspace);
    expect(() => requirePdfProfile(restored)).not.toThrow();
    const corrupted = structuredClone(profile);
    corrupted.manifest.versions[PDF_EXECUTABLES.info] = "wrong";
    const priorCalls = vi.mocked(spawn).mock.calls.length;
    await expect(assertPdfProfile(corrupted, workspace)).rejects.toThrow("digest is invalid");
    expect(vi.mocked(spawn).mock.calls.length).toBe(priorCalls);
  });

  it("rejects unauthorized or symlinked workspaces", async () => {
    await expect(createPdfWorkspace("/tmp/pdf")).rejects.toThrow("authorized external boundary");
    await expect(createPdfWorkspace(`${workspace}/../pdf-unit`)).rejects.toThrow("normalized");
    fake.links.set(workspace, "/outside");
    await expect(createPdfWorkspace(workspace)).rejects.toThrow("Symlink");
  });
});

describe("bounded native execution", () => {
  it("uses trusted absolute executables and explicit process resource bounds", async () => {
    const context = await createPdfWorkspace(workspace);
    await runPdfNative(PDF_EXECUTABLES.info, ["input.pdf"], context);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/prlimit",
      [
        "--as=1073741824",
        "--cpu=20",
        "--fsize=33554432",
        "--nofile=64",
        "--core=0",
        "--",
        "/usr/bin/pdfinfo",
        "input.pdf",
      ],
      expect.objectContaining({ cwd: context.directory, shell: false }),
    );
    await expect(runPdfNative("/tmp/pdftotext", [], context)).rejects.toThrow("Untrusted");
  });

  it.each(["output", "diagnostics"])("kills a subprocess exceeding %s bounds", async (mode) => {
    const context = await createPdfWorkspace(workspace);
    fake.mode = mode;
    const failure = await runPdfNative(PDF_EXECUTABLES.info, [], context, 8).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(PdfEvidenceError);
    expect((failure as Error).message).toMatch(/exceeded its (output|diagnostic) limit/);
    const directory = (failure as PdfEvidenceError).evidenceDirectory;
    expect(directory).toBe(`${context.directory}/native-private`);
    const retained = vi
      .mocked(writeFile)
      .mock.calls.find(([path]) => path === `${directory}/${mode === "output" ? "stdout" : "stderr"}`)!;
    expect(retained[1]).toBeInstanceOf(Buffer);
    expect((retained[1] as Buffer).length).toBe(mode === "output" ? 8 : PDF_LIMITS.diagnosticBytes);
    if (mode === "output") expect((retained[1] as Buffer).toString()).toBe("12345678");
    expect(retained[2]).toEqual({ flag: "wx", mode: 0o600 });
    const receipt = JSON.parse(
      vi
        .mocked(writeFile)
        .mock.calls.find(([path]) => path === `${directory}/result.json`)![1]!
        .toString(),
    );
    expect(receipt[mode === "output" ? "stdoutTruncated" : "stderrTruncated"]).toBe(true);
    expect(fake.killed).toBe(true);
  });

  it("kills timed-out subprocesses before resolving or cleaning their workspace", async () => {
    const context = await createPdfWorkspace(workspace);
    fake.mode = "hold";
    vi.useFakeTimers();
    try {
      const pending = runPdfNative(PDF_EXECUTABLES.info, [], context);
      const rejected = expect(pending).rejects.toThrow("wall-time limit");
      await vi.advanceTimersByTimeAsync(PDF_LIMITS.timeoutMs);
      await rejected;
      expect(fake.killed).toBe(true);
      expect(writeFile).toHaveBeenCalledWith(
        `${context.directory}/native-private/stdout`,
        Buffer.from("partial output"),
        { flag: "wx", mode: 0o600 },
      );
      expect(writeFile).toHaveBeenCalledWith(
        `${context.directory}/native-private/stderr`,
        Buffer.from("partial diagnostic"),
        { flag: "wx", mode: 0o600 },
      );
      const receipt = JSON.parse(
        vi
          .mocked(writeFile)
          .mock.calls.find(([path]) => path.toString().endsWith("/result.json"))![1]!
          .toString(),
      );
      expect(receipt).toMatchObject({
        exitCode: null,
        signal: "SIGKILL",
        failure: "PDF subprocess exceeded its wall-time limit",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["spawn-error", "nonzero"])("rejects %s without disclosing native output", async (mode) => {
    const context = await createPdfWorkspace(workspace);
    fake.mode = mode;
    const error = await runPdfNative(PDF_EXECUTABLES.info, [], context).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private native details");
    const writes = vi.mocked(writeFile).mock.calls;
    const receipt = JSON.parse(writes.find(([path]) => path.toString().endsWith("/result.json"))![1]!.toString());
    expect(receipt.exitCode).toBe(mode === "spawn-error" ? -2 : 1);
    if (mode === "spawn-error") expect(receipt.spawnError.message).toBe("private native details");
    else
      expect(writes.find(([path]) => path.toString().endsWith("/stderr"))![1]!.toString()).toBe(
        "private native details",
      );
  });

  it("identifies retained native context when evidence writes fail", async () => {
    const context = await createPdfWorkspace(workspace);
    vi.mocked(writeFile).mockImplementation(async (path) => {
      if (path.toString().endsWith("/stdout")) throw new Error("private disk failure");
    });
    const failure = await runPdfNative(PDF_EXECUTABLES.info, [], context).catch((error: Error) => error);
    expect(failure).toMatchObject({
      evidenceDirectory: `${context.directory}/native-private`,
      evidenceComplete: false,
    });
    expect((failure as Error).message).toContain("evidence persistence incomplete");
    expect(rm).not.toHaveBeenCalled();
  });
});
