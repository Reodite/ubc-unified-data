import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionFormats } from "./collect.ts";
import { withMarkdownCollectionRuntime } from "./markdown-collection-runtime.ts";
import { inspectMarkdownSource } from "./markdown-inspection.mjs";

const fetchGuard = vi.fn(() => {
  throw new Error("Unexpected network access");
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchGuard.mockClear();
});

describe("authenticated Markdown collection runtime ownership", () => {
  it("prepares one real authority, inspects through the canonical request and disposes before returning", async () => {
    const bytes = Buffer.from("# Runtime title\n\nExact [relative link](/node/1).\n", "utf8");
    let retained: NonNullable<CollectionFormats["markdown"]> | undefined;
    const result = await withMarkdownCollectionRuntime(true, async (format) => {
      if (!format) throw new Error("Missing enabled Markdown format");
      retained = format;
      expect(Object.isFrozen(format)).toBe(true);
      expect(Object.keys(format)).toEqual(["profile_sha256", "inspect"]);
      const inspected = await format.inspect(bytes, ["Advertised fallback"]);
      expect(inspected.inspection).toEqual(inspectMarkdownSource(bytes, ["Advertised fallback"]));
      expect(inspected.profile_sha256).toBe(format.profile_sha256);
      return inspected.inspection.title;
    });
    expect(result.value).toBe("Runtime title");
    expect(result.profile_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    await expect(retained!.inspect(bytes, [])).rejects.toThrow(/unavailable/i);
    expect(fetchGuard).not.toHaveBeenCalled();
  }, 180_000);

  it("does not prepare authority when Markdown is disabled", async () => {
    const result = await withMarkdownCollectionRuntime(false, async (format) => {
      expect(format).toBeUndefined();
      return "ordinary collection";
    });
    expect(result).toEqual({ value: "ordinary collection", profile_sha256: null });
  });

  it("preserves callback failure and still revokes the real authority", async () => {
    const bytes = Buffer.from("# Runtime title\n", "utf8");
    let retained: NonNullable<CollectionFormats["markdown"]> | undefined;
    await expect(
      withMarkdownCollectionRuntime(true, async (format) => {
        retained = format!;
        throw new Error("injected collection failure");
      }),
    ).rejects.toThrow("injected collection failure");
    await expect(retained!.inspect(bytes, [])).rejects.toThrow(/unavailable/i);
    expect(fetchGuard).not.toHaveBeenCalled();
  }, 180_000);

  it("forwards active inspection cancellation and still revokes authority", async () => {
    const controller = new AbortController();
    const bytes = Buffer.from("# Runtime title\n\nCancellation.\n", "utf8");
    let retained: NonNullable<CollectionFormats["markdown"]> | undefined;
    await expect(
      withMarkdownCollectionRuntime(
        true,
        async (format) => {
          retained = format!;
          const active = retained.inspect(bytes, []);
          controller.abort(new Error("cancelled runtime bridge inspection"));
          return active;
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled runtime bridge inspection");
    await expect(retained!.inspect(bytes, [])).rejects.toThrow(/unavailable/i);
  }, 180_000);

  it("preserves an undefined callback rejection and still disposes authority", async () => {
    let rejected = false;
    try {
      await withMarkdownCollectionRuntime(true, async () => {
        throw undefined;
      });
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }
    expect(rejected).toBe(true);
  }, 180_000);

  it("honors cancellation before authority preparation without invoking collection", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled collection preparation"));
    const callback = vi.fn(async () => "unreachable");
    await expect(withMarkdownCollectionRuntime(true, callback, { signal: controller.signal })).rejects.toThrow(
      "cancelled collection preparation",
    );
    expect(callback).not.toHaveBeenCalled();
  });
});
