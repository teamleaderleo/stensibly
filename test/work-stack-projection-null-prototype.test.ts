import { expect, test } from "bun:test";
import { snapshotPlainObject } from "../src/work-stack-projection-validation.ts";

test("work-stack caller snapshot accepts null-prototype records without enumeration", () => {
  const value = Object.assign(Object.create(null), {
    version: 1,
    ignoredDecoration: "discarded",
  });
  let ownKeysCalls = 0;
  const hostile = new Proxy(value, {
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("caller ownKeys must remain unreachable");
    },
  });

  const snapshot = snapshotPlainObject(hostile, ["version"], "work-stack input");

  expect(snapshot.version).toBe(1);
  expect(Object.getPrototypeOf(snapshot)).toBeNull();
  expect("ignoredDecoration" in snapshot).toBe(false);
  expect(ownKeysCalls).toBe(0);
});
