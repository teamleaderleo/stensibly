export type CapturedDataMethod = (...args: unknown[]) => unknown;

const maximumPrototypeDepth = 64;

export function captureDataMethod(
  value: unknown,
  name: string,
): CapturedDataMethod | null {
  if (!value || typeof value !== "object") return null;

  let current: object | null = value;
  const seen = new Set<object>();
  try {
    while (current && current !== Object.prototype) {
      if (seen.has(current) || seen.size >= maximumPrototypeDepth) return null;
      seen.add(current);

      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") {
          return null;
        }
        return (...args: unknown[]) => Reflect.apply(descriptor.value, value, args);
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return null;
  }
  return null;
}