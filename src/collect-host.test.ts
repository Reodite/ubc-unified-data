import { afterEach, describe, expect, it, vi } from "vitest";
import { runCollectHost } from "./collect-host.ts";

afterEach(() => vi.unstubAllGlobals());
describe("explicit host command boundaries", () => {
  it.each(
    [
      [],
      ["--host", "unknown.ubc.ca", "--acquire"],
      ["--host", "bmlscpathology.med.ubc.ca", "--acquire", "--publish"],
      ["--host", "bmlscpathology.med.ubc.ca", "--resume-interrupted"],
      ["--host", "bmlscpathology.med.ubc.ca", "--retry-network", "https://bmlscpathology.med.ubc.ca/missing"],
      ["--host", "bmlscpathology.med.ubc.ca", "--approve"],
      ["--host", "bmlscpathology.med.ubc.ca", "--external-root", ".cache"],
    ].map((args) => ({ args })),
  )("rejects unsafe or ambiguous arguments before network: $args", async ({ args }) => {
    const network = vi.fn(() => {
      throw new Error("Unexpected network");
    });
    vi.stubGlobal("fetch", network);
    await expect(runCollectHost(args)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
});
