import { describe, expect, test } from "bun:test";

describe("red-control CI dogfood", () => {
  test("remains red until absorbed by the parent", () => {
    expect("red-control child").toBe("absorbed parent");
  });
});
