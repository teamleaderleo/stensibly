import { expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
  type EffectiveToolSurfaceHostBindingSnapshotInput,
} from "../src/effective-tool-surface-host-binding.ts";

test("normalizes hostile values thrown during caller inspection without inspecting them", () => {
  let thrownPrototypeReads = 0;
  const hostileThrownValue = new Proxy(Object.create(null), {
    getPrototypeOf() {
      thrownPrototypeReads += 1;
      throw new Error("caught provider/caller value must remain opaque");
    },
  });

  const hostileInput = new Proxy(Object.create(null), {
    getPrototypeOf() {
      throw hostileThrownValue;
    },
  });

  expect(() => buildEffectiveToolSurfaceHostBindingSnapshot(
    hostileInput as EffectiveToolSurfaceHostBindingSnapshotInput,
  )).toThrow("Effective tool-surface host-binding input inspection failed");
  expect(thrownPrototypeReads).toBe(0);
});
