import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMarkdownCollectionRuntime } from "./markdown-collection-runtime.ts";

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
  it("does not prepare authority when Markdown is disabled", async () => {
    const result = await withMarkdownCollectionRuntime(false, async (format) => {
      expect(format).toBeUndefined();
      return "ordinary collection";
    });
    expect(result).toEqual({ value: "ordinary collection", profile_sha256: null });
  });

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
