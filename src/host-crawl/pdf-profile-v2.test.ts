import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import {
  assertPdfV2Profile,
  capturePdfV2Profile,
  PDF_V2_EXECUTABLES,
  PDF_V2_LIMITS,
  PDF_V2_OCR_ARGUMENTS,
  PDF_V2_TEXT_ARGUMENTS,
  requirePdfV2Profile,
} from "./pdf-profile-v2.ts";

const workspace = join(DEFAULT_EXTERNAL_ROOT, "test-pdf-v2-profile");
const profile = await capturePdfV2Profile(workspace);
let failed = false;
afterEach((context) => {
  if (context.task.result?.state === "fail") failed = true;
});
afterAll(async () => {
  if (failed) console.error(`Preserved PDF v2 profile fixture root: ${workspace}`);
  else await rm(workspace, { recursive: true, force: true });
});

describe("PDF v2 authenticated profile", () => {
  it("uses a distinct schema and binds every executable, runtime, library and English OCR resource", () => {
    expect(profile.manifest.schema).toBe("host-pdf-profile-v2");
    expect(profile.sha256).toMatch(/^[a-f\d]{64}$/);
    expect(profile.manifest.runtime).toMatchObject({
      executable: process.execPath,
      version: process.version,
      versions: expect.objectContaining({ node: process.versions.node }),
    });
    for (const executable of Object.values(PDF_V2_EXECUTABLES)) {
      expect(isAbsolute(executable)).toBe(true);
      expect(profile.manifest.versions[executable]).toBeTruthy();
      expect(profile.manifest.resources.some((resource) => resource.path === executable)).toBe(true);
      if (executable !== PDF_V2_EXECUTABLES.loader)
        expect(profile.manifest.linkedLibraries[executable]!.length).toBeGreaterThan(0);
    }
    expect(profile.manifest.ocrResources).toEqual([
      "/usr/share/tessdata/eng.traineddata",
      "/usr/share/tessdata/configs/tsv",
    ]);
    for (const path of profile.manifest.ocrResources) {
      expect(profile.manifest.resources.find((resource) => resource.path === path)).toMatchObject({
        kind: "file",
        sha256: expect.stringMatching(/^[a-f\d]{64}$/),
      });
    }
    expect(() => requirePdfV2Profile(profile)).not.toThrow();
    expect(Object.isFrozen(profile.manifest.resources)).toBe(true);
  });

  it("binds default reading-order text, fixed TSV OCR and practical native limits", () => {
    expect(profile.manifest.extraction.textArguments).toEqual(PDF_V2_TEXT_ARGUMENTS);
    expect(profile.manifest.extraction.textArguments).not.toContain("-layout");
    expect(profile.manifest.extraction.ocrArguments).toEqual(PDF_V2_OCR_ARGUMENTS);
    expect(profile.manifest.extraction).toMatchObject({
      nativePageBoundary: "form-feed",
      ocrFormat: "tsv",
      lineOrder: "tesseract-block-paragraph-line-word-v1",
      environment: expect.objectContaining({
        LC_ALL: "C",
        LANG: "C",
        TZ: "UTC",
        OMP_THREAD_LIMIT: "1",
        TESSDATA_PREFIX: "/usr/share/tessdata",
      }),
      fontconfigSha256: expect.stringMatching(/^[a-f\d]{64}$/),
    });
    expect(profile.manifest.extraction.limitArguments).toEqual([
      `--as=${PDF_V2_LIMITS.addressSpaceBytes}`,
      `--cpu=${PDF_V2_LIMITS.cpuSeconds}`,
      `--fsize=${PDF_V2_LIMITS.outputBytes}`,
      `--nofile=${PDF_V2_LIMITS.openFiles}`,
      "--core=0",
      "--",
    ]);
    expect(profile.manifest.extraction.limits).toMatchObject({
      pages: 500,
      ocrPages: 50,
      rasterDpi: 200,
      timeoutMs: 30_000,
      openFiles: 64,
      temporaryFiles: 4096,
    });
  });

  it("does not authorize clones and rejects digest tampering before dependency capture", async () => {
    const clone = structuredClone(profile);
    expect(() => requirePdfV2Profile(clone)).toThrow("Capture or assert");
    clone.manifest.extraction.ocrArguments = [...clone.manifest.extraction.ocrArguments, "quiet"];
    await expect(assertPdfV2Profile(clone, workspace)).rejects.toThrow("digest is invalid");
  });

  it("rechecks a serialized profile against current authenticated dependencies", async () => {
    const restored = structuredClone(profile);
    await assertPdfV2Profile(restored, workspace);
    expect(() => requirePdfV2Profile(restored)).not.toThrow();
    expect(restored).toEqual(profile);
  }, 30_000);
});
