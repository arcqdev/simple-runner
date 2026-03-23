import { describe, expect, it } from "vitest";

import { stringifyJson, toJsonObject, toJsonValue } from "../../src/runtime/json.js";

describe("runtime json helpers", () => {
  it("normalizes non-JSON-safe values into stable JSON values", () => {
    const value = toJsonValue({
      big: 10n,
      date: new Date("2026-03-23T10:11:12.000Z"),
      fn: (input: unknown) => input,
      inf: Number.POSITIVE_INFINITY,
      nested: [new URL("https://example.com/a"), undefined],
    });

    expect(value).toEqual({
      big: "10",
      date: "2026-03-23T10:11:12.000Z",
      fn: expect.stringContaining("input"),
      inf: "Infinity",
      nested: ["https://example.com/a", null],
    });
  });

  it("prefers custom toJSON implementations and stringifies normalized payloads", () => {
    const payload = {
      record: {
        toJSON() {
          return { ok: true, extra: undefined };
        },
      },
    };

    expect(toJsonObject(payload)).toEqual({
      record: { ok: true, extra: null },
    });
    expect(stringifyJson(payload)).toBe('{"record":{"ok":true,"extra":null}}');
  });
});
