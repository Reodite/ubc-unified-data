import { describe, expect, it } from "vitest";
import { Http } from "../core/http.ts";
import {
  collectNumberedPages,
  isUnvisitedCollectionPage,
  nextLink,
  pageTotalsAgree,
  sequentialNumberedPages,
} from "./pagination.ts";

describe("numbered page collection", () => {
  it("bounds the pool and appends batches in page order rather than completion order", async () => {
    const second = Promise.withResolvers<void>();
    const third = Promise.withResolvers<void>();
    const poolStarted = Promise.withResolvers<void>();
    const fourthStarted = Promise.withResolvers<void>();
    const started: number[] = [];
    const completed: number[] = [];
    const first = [1];
    const pending = collectNumberedPages(
      new Http({ workers: 8 }),
      first,
      4,
      async (page) => {
        started.push(page);
        if (page === 3) poolStarted.resolve();
        if (page === 4) fourthStarted.resolve();
        if (page === 2) await second.promise;
        if (page === 3) await third.promise;
        completed.push(page);
        return [page];
      },
      2,
    );
    await poolStarted.promise;
    expect(started).toEqual([2, 3]);
    expect(first).toEqual([1]);
    third.resolve();
    await fourthStarted.promise;
    expect(completed).toEqual([3, 4]);
    second.resolve();
    expect(await pending).toBe(first);
    expect(first).toEqual([1, 2, 3, 4]);
  });

  it("requests subsequent sequential pages only when the consumer advances", async () => {
    const calls: number[] = [];
    const pages = sequentialNumberedPages(
      async (page) => {
        calls.push(page);
        return { page, pages: 3 };
      },
      (first) => first.pages,
    );
    expect(calls).toEqual([]);
    expect((await pages.next()).value).toEqual({ page: 1, pages: 3 });
    expect(calls).toEqual([1]);
    expect((await pages.next()).value).toEqual({ page: 2, pages: 3 });
    expect(calls).toEqual([1, 2]);
    await pages.return(undefined);
    expect(calls).toEqual([1, 2]);
  });

  it("reads the first sequential page for zero totals without scheduling a second request", async () => {
    const calls: number[] = [];
    const pages = sequentialNumberedPages(
      async (page) => {
        calls.push(page);
        return 0;
      },
      (total) => total,
    );
    const values = [];
    for await (const value of pages) values.push(value);
    expect(values).toEqual([0]);
    expect(calls).toEqual([1]);
    expect(
      await collectNumberedPages(new Http(), [], 0, async () => {
        throw new Error("unexpected page");
      }),
    ).toEqual([]);
  });
});

describe("pagination validation primitives", () => {
  it.each([
    [0, 0, true],
    [0, 1, false],
    [100, 1, true],
    [101, 2, true],
    [101, 1, false],
    [-1, 0, false],
    [1.5, 1, false],
    [Number.NaN, 1, false],
    [Number.MAX_SAFE_INTEGER + 1, Math.ceil((Number.MAX_SAFE_INTEGER + 1) / 100), false],
  ])("checks numeric totals %s/%s without parsing header syntax", (total, pages, expected) => {
    expect(pageTotalsAgree(total, pages, 100)).toBe(expected);
  });

  it.each([null, undefined, "?page=2", { href: "?page=2" }])("reads optional next links: %j", (value) => {
    expect(nextLink(value, () => new Error("invalid"))).toBe(value == null ? null : "?page=2");
  });

  it.each(["", {}, [], { href: "" }, { href: 2 }, 2, false])("rejects malformed advertised links: %j", (value) => {
    const error = new Error("caller-specific failure");
    expect(() => nextLink(value, () => error)).toThrow(error);
  });

  it("rejects repeated and cross-collection URLs without imposing monotonic offsets", () => {
    const origin = "https://test.ubc.ca";
    const pathname = "/jsonapi/node/page";
    const previous = `${origin}${pathname}?page%5Boffset%5D=50`;
    const visited = new Set([previous]);
    expect(isUnvisitedCollectionPage(new URL(previous), origin, pathname, visited)).toBe(false);
    expect(isUnvisitedCollectionPage(new URL(`${origin}/jsonapi/node/other`), origin, pathname, visited)).toBe(false);
    expect(isUnvisitedCollectionPage(new URL(`https://other.ubc.ca${pathname}`), origin, pathname, visited)).toBe(
      false,
    );
    expect(
      isUnvisitedCollectionPage(new URL(`${origin}${pathname}?page%5Boffset%5D=0`), origin, pathname, visited),
    ).toBe(true);
  });
});
