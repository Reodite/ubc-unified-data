import { describe, expect, it, vi } from "vitest";
import { readResponseBytes } from "./response.ts";

describe("response byte reader", () => {
  it("preserves bytes and reports cumulative size for each chunk", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 255]));
          controller.enqueue(new Uint8Array([195, 169]));
          controller.close();
        },
      }),
    );
    const accept = vi.fn();
    expect(await readResponseBytes(response, accept)).toEqual(Buffer.from([0, 255, 195, 169]));
    expect(accept.mock.calls).toEqual([[2], [4]]);
    expect(response.body!.locked).toBe(false);
  });

  it("returns an empty buffer for a bodyless response", async () => {
    const accept = vi.fn();
    expect(await readResponseBytes(new Response(null), accept)).toEqual(Buffer.alloc(0));
    expect(accept).not.toHaveBeenCalled();
  });

  it("cancels a stream when its caller rejects the byte budget", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel,
      }),
    );
    const error = new Error("Byte budget exceeded");
    await expect(
      readResponseBytes(response, (size) => {
        if (size > 2) throw error;
      }),
    ).rejects.toBe(error);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  });

  it("preserves read failures and releases the reader", async () => {
    const error = new Error("Connection closed");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(error);
        },
      }),
    );
    await expect(readResponseBytes(response)).rejects.toBe(error);
    expect(response.body!.locked).toBe(false);
  });
});
