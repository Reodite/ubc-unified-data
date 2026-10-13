import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as campus from "./campus.ts";
import * as http from "./http.ts";
import * as output from "./output.ts";
import * as serialization from "./serialization.ts";
import * as wordpress from "./wordpress.ts";

describe("core infrastructure contracts", () => {
  it("preserves campus selection and rejects invalid values", () => {
    const previous = campus.selectedCampus();
    try {
      campus.setCampus("okanagan");
      expect(campus.selectedCampus()).toBe("okanagan");
      expect(campus.wants("vancouver")).toBe(false);
      campus.setCampus("both");
      expect(campus.selectedCampus()).toBe("both");
      expect(campus.wants("vancouver")).toBe(true);
      expect(() => campus.setCampus("mars")).toThrow(http.InvalidValueError);
      expect(() => campus.setCampus("mars")).toThrow(
        "campus must be one of 'vancouver', 'okanagan', 'both', got 'mars'",
      );
      expect(campus.selectedCampus()).toBe("both");
    } finally {
      campus.setCampus(previous);
    }
  });

  it("preserves repository-relative default disk paths", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    expect(output.ROOT).toBe(path.resolve(root));
    expect(output.DATA_DIR).toBe(path.join(root, "data"));
    expect(new output.Output("group").base).toBe(path.join(root, "data", "group"));
    expect(output.PRETTY_LIMIT).toBe(2000);
  });
});

describe("serialization byte contracts", () => {
  it("preserves float markers, negative zero, special values, and exponent padding", () => {
    const values = [0, -0, 3, 3.5, 1e-7, NaN, Infinity, -Infinity];
    expect(serialization.stringifyJson(values)).toBe("[0,-0,3,3.5,1e-7,NaN,Infinity,-Infinity]");
    expect(serialization.stringifyJson(values.map(serialization.floatValue))).toBe(
      "[0.0,-0.0,3.0,3.5,1e-07,NaN,Infinity,-Infinity]",
    );
    expect(serialization.stringifyCsv(values.map((value) => ({ n: value, f: serialization.floatValue(value) })))).toBe(
      "n,f\r\n0,0.0\r\n0,-0.0\r\n3,3.0\r\n3.5,3.5\r\n1e-7,1e-07\r\nNaN,NaN\r\nInfinity,Infinity\r\n-Infinity,-Infinity\r\n",
    );
  });

  it("preserves string escaping, literal Unicode, separators, and empty CSV cells", () => {
    expect(serialization.stringToJson('é中\u007f\u2028\u0000\b\f\n\r\t"\\')).toBe(
      '"é中\u007f\u2028\\u0000\\b\\f\\n\\r\\t\\"\\\\"',
    );
    expect(serialization.stringifyJson({ b: undefined, a: [1, true, null] }, null, [", ", ": "])).toBe(
      '{"b": null, "a": [1, true, null]}',
    );
    expect(serialization.stringifyCsv([])).toBe("\r\n");
    expect(serialization.stringifyCsv([{ cell: null }, { cell: undefined }, { cell: "" }])).toBe(
      'cell\r\n""\r\n""\r\n""\r\n',
    );
  });

  it("writes identical UTF-8 bytes and manifest metadata through direct Output imports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "core-output-"));
    try {
      const out = new output.Output("group", root);
      const spec: output.DocSpec = { grain: "one row", columns: { n: "amount" }, joins: ["other.n"] };
      out.describe("nested/table.v1", spec);
      spec.columns.n = "changed";
      await out.table("nested/table.v1", [{ n: serialization.floatValue(2), label: "é", active: true }], {
        source: "https://example.test",
      });
      const expected = [
        '[\n  {\n    "n": 2.0,\n    "label": "é",\n    "active": true\n  }\n]',
        "n,label,active\r\n2.0,é,True\r\n",
      ];
      for (const [index, extension] of ["json", "csv"].entries()) {
        const relative = `group/nested/table.v1.${extension}`;
        const bytes = Buffer.from(expected[index]!, "utf8");
        expect(await readFile(path.join(root, relative))).toEqual(bytes);
        expect(out.datasets[index]).toEqual({
          path: relative,
          records: 1,
          bytes: bytes.length,
          source: "https://example.test",
          grain: "one row",
          columns: { n: "amount" },
          joins: ["other.n"],
        });
      }
      await out.json("items.json", [{ n: serialization.floatValue(-0) }], { itemsPerLine: true });
      expect(await readFile(path.join(root, "group/items.json"), "utf8")).toBe('[\n  {"n":-0.0}\n]');
      await out.table("empty", []);
      expect(await readFile(path.join(root, "group/empty.json"), "utf8")).toBe("[]");
      await expect(readFile(path.join(root, "group/empty.csv"))).rejects.toMatchObject({ code: "ENOENT" });
      const bytes = new Uint8Array([0, 1, 2, 3]).subarray(1, 3);
      expect(await out.raw("bytes.bin", bytes)).toBe("group/bytes.bin");
      expect(await readFile(path.join(root, "group/bytes.bin"))).toEqual(Buffer.from([1, 2]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("error and utility contracts", () => {
  it("keeps status reasons, fallbacks, and literal parsing errors", () => {
    expect(http.errorName("failure")).toBe("Exception");
    expect(http.errorMessage(null)).toBe("null");
    expect(() => http.throwForStatus(404, "url")).toThrow(
      new http.HTTPError("404 Client Error: Not Found for url: url"),
    );
    expect(() => http.throwForStatus(418, "url")).toThrow(
      new http.HTTPError("418 Client Error: Client Error for url: url"),
    );
    expect(() => http.throwForStatus(503, "url")).toThrow(
      new http.HTTPError("503 Server Error: Service Unavailable for url: url"),
    );
    expect(() => http.throwForStatus(599, "url")).toThrow(
      new http.HTTPError("599 Server Error: Server Error for url: url"),
    );
    expect(() => wordpress.jsLiteral("", "data")).toThrow(new http.MissingKeyError("data"));
    expect(() => wordpress.jsLiteral("var data = [", "data")).toThrow(
      new http.InvalidValueError("unterminated literal for data"),
    );
  });
});
