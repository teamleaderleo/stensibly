import { expect, test } from "bun:test";
import { recordApplicationLaneWakeIntent } from "../src/application-lane-wake-store.ts";
import { StensiblyStore } from "../src/store.ts";

test("durable application wake admission rejects top-level accessors without invocation", () => {
  const store = new StensiblyStore(":memory:");
  let getterCalls = 0;
  try {
    const input = Object.defineProperty({
      currentBinding: {},
      currentAuthority: {},
      event: {},
    }, "registration", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });

    expect(() => recordApplicationLaneWakeIntent(store, input)).toThrow(
      "Application lane wake record input must contain enumerable data properties",
    );
    expect(getterCalls).toBe(0);

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => recordApplicationLaneWakeIntent(store, proxy)).toThrow(
      "Application lane wake record input inspection failed",
    );
  } finally {
    store.close();
  }
});
