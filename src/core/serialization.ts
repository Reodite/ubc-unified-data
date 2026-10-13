/** Byte-stable dataset writers. Wrap float-transformed numbers with `floatValue()`
 * to preserve integral `.0`; plain numbers retain integer spelling. */

export interface FloatValue {
  __float: true;
  value: number;
}
export function floatValue(value: number): FloatValue {
  return { __float: true, value };
}
export function isFloatValue(value: unknown): value is FloatValue {
  return typeof value === "object" && value !== null && (value as { __float?: unknown }).__float === true;
}

/** Shortest round trip with two-digit exponent padding (`1e-07`). */
function floatRepr(value: number): string {
  return String(value).replace(/e([+-])(\d)$/, "e$10$2");
}

/** Integral floats keep `.0`; other dataset magnitudes use shortest round trip. */
function floatToJson(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  if (Number.isInteger(value)) return `${value}.0`;
  return floatRepr(value);
}

export function numberToJson(value: number, isFloat = false): string {
  return isFloat ? floatToJson(value) : Object.is(value, -0) ? "-0" : String(value);
}

export function stringToJson(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default:
        // Only C0 controls are escaped; non-ASCII stays literal.
        if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
        else out += char;
    }
  }
  return `${out}"`;
}

/** Serialize JSON with literal non-ASCII. Null/zero indent uses `separators`;
 * positive indent uses newlines and a `": "` key separator. */
export function stringifyJson(
  value: unknown,
  indent: number | null = 0,
  separators: [string, string] = [",", ":"],
): string {
  return serialize(value, indent ?? 0, separators, 0);
}

/** Serialize a list with one compact item per line. */
export function stringifyJsonItems(value: unknown[]): string {
  if (value.length === 0) return "[]";
  const body = value.map((item) => serialize(item, 0, [",", ":"], 1));
  return `[\n${body.map((item) => `  ${item}`).join(",\n")}\n]`;
}

function serialize(value: unknown, indent: number, separators: [string, string], level: number): string {
  if (isFloatValue(value)) return floatToJson(value.value);
  if (typeof value === "number") return numberToJson(value);
  if (typeof value === "string") return stringToJson(value);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const body = value.map((item) => serialize(item, indent, separators, level + 1));
    if (indent) {
      const pad = " ".repeat((level + 1) * indent);
      const inner = body.map((item) => `${pad}${item}`).join(",\n");
      return `[\n${inner}\n${" ".repeat(level * indent)}]`;
    }
    return `[${body.join(separators[0])}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) return "{}";
    const keySep = indent ? ": " : separators[1];
    const body = keys.map(
      (key) => `${stringToJson(key)}${keySep}${serialize(record[key], indent, separators, level + 1)}`,
    );
    if (indent) {
      const pad = " ".repeat((level + 1) * indent);
      const inner = body.map((item) => `${pad}${item}`).join(",\n");
      return `{\n${inner}\n${" ".repeat(level * indent)}}`;
    }
    return `{${body.join(separators[0])}}`;
  }
  return "null";
}

/** Serialize nested CSV cells as compact JSON; leave primitives and float markers intact. */
export function csvScalar(value: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    isFloatValue(value)
  ) {
    return value;
  }
  return stringifyJson(value, 0, [", ", ": "]);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (isFloatValue(value)) return floatToJson(value.value);
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (isFloatValue(value)) return floatToJson(value.value);
  return String(value);
}

/** Quote commas, quotes, CR/LF, and a lone empty cell; double embedded quotes. */
function csvField(value: unknown, singleColumn: boolean): string {
  const text = cellText(value);
  const quote =
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\r") ||
    text.includes("\n") ||
    (singleColumn && text === "");
  if (!quote) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Write header and data rows with CRLF terminators. `columns` overrides the header. */
export function stringifyCsv(rows: Array<Record<string, unknown>>, options: { columns?: string[] } = {}): string {
  const cells =
    options.columns ??
    (() => {
      const seen: string[] = [];
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          if (!seen.includes(key)) seen.push(key);
        }
      }
      return seen;
    })();
  const single = cells.length === 1;
  const lines = [cells.map((c) => csvField(c, single)).join(",")];
  for (const row of rows) {
    lines.push(cells.map((c) => csvField(csvScalar(row[c]), single)).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
