import { describe, expect, test } from "bun:test";
import { captureDataMethod } from "../src/captured-data-method.ts";

describe("captureDataMethod", () => {
  test("captures own and inherited data methods with the original receiver", () => {
    const prototype = {
      inherited(this: { value: number }, increment: number) {
        return this.value + increment;
      },
    };
    const target = Object.assign(Object.create(prototype), {
      value: 7,
      own(this: { value: number }, multiplier: number) {
        return this.value * multiplier;
      },
    });

    expect(captureDataMethod(target, "own")?.(3)).toBe(21);
    expect(captureDataMethod(target, "inherited")?.(5)).toBe(12);
  });

  test("rejects accessors without invoking them", () => {
    let getterCalls = 0;
    const target = Object.create({ operation() { return "prototype"; } });
    Object.defineProperty(target, "operation", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return () => "accessor";
      },
    });

    expect(captureDataMethod(target, "operation")).toBeNull();
    expect(getterCalls).toBe(0);
  });

  test("rejects non-function shadows instead of falling through to a prototype", () => {
    const target = Object.create({ operation() { return "prototype"; } });
    Object.defineProperty(target, "operation", {
      value: "shadowed",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(captureDataMethod(target, "operation")).toBeNull();
  });

  test("normalizes hostile descriptor and prototype traps without retaining prose", () => {
    const descriptorTrap = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("github_pat_must_not_escape");
      },
    });
    expect(captureDataMethod(descriptorTrap, "operation")).toBeNull();

    const prototypeTrap = new Proxy({}, {
      getOwnPropertyDescriptor() {
        return undefined;
      },
      getPrototypeOf() {
        throw new Error("authorization: must not escape");
      },
    });
    expect(captureDataMethod(prototypeTrap, "operation")).toBeNull();
  });

  test("bounds cyclic prototype traversal", () => {
    let prototypeReads = 0;
    let cyclic: object;
    cyclic = new Proxy({}, {
      getOwnPropertyDescriptor() {
        return undefined;
      },
      getPrototypeOf() {
        prototypeReads += 1;
        return cyclic;
      },
    });

    expect(captureDataMethod(cyclic, "operation")).toBeNull();
    expect(prototypeReads).toBe(1);
  });

  test("does not suppress failures from an admitted method invocation", () => {
    const target = {
      operation() {
        throw new Error("method execution failed");
      },
    };
    const captured = captureDataMethod(target, "operation");
    expect(captured).not.toBeNull();
    expect(() => captured?.()).toThrow("method execution failed");
  });

  test("supports null-prototype objects and excludes Object.prototype", () => {
    const target = Object.create(null) as Record<string, unknown>;
    target.operation = function (this: { marker: string }) {
      return this.marker;
    };
    target.marker = "bound";

    expect(captureDataMethod(target, "operation")?.()).toBe("bound");
    expect(captureDataMethod({}, "toString")).toBeNull();
  });

  test("rejects null, primitives, and absent methods", () => {
    for (const value of [null, undefined, "text", 1, true]) {
      expect(captureDataMethod(value, "operation")).toBeNull();
    }
    expect(captureDataMethod({}, "operation")).toBeNull();
  });
});