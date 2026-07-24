import { expect, test } from "bun:test";
import { payloadEntries } from "../site/item-detail.js";

test("dashboard item detail formats undefined payload values", () => {
  expect(payloadEntries({ missing: undefined })).toEqual([
    { key: "missing", value: "undefined" },
  ]);
});
