type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

const maximumDepth = 24;
const maximumNodes = 10_000;
const maximumArrayLength = 1_024;

/**
 * Detach one bounded object graph from caller-owned descriptors without invoking accessors.
 * The downstream compiler still performs its ordinary exact schema admission on this copy.
 */
export function snapshotSynchronizationInput(input: unknown): unknown {
  const active = new WeakSet<object>();
  let nodes = 0;

  const copy = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (depth > maximumDepth || nodes > maximumNodes) {
      throw new TypeError("Synchronization input exceeds the descriptor snapshot limit");
    }
    if (value === null || typeof value !== "object") return value;
    if (active.has(value)) {
      throw new TypeError("Synchronization input must not contain cycles");
    }
    active.add(value);
    try {
      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
      const keys = Reflect.ownKeys(descriptors);

      if (Array.isArray(value)) {
        const lengthDescriptor = descriptors.length;
        if (
          !lengthDescriptor
          || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value)
          || (lengthDescriptor.value as number) < 0
          || (lengthDescriptor.value as number) > maximumArrayLength
        ) {
          throw new TypeError("Synchronization input contains an invalid array length");
        }
        const output: unknown[] = [];
        Object.setPrototypeOf(output, prototype);
        for (const key of keys) {
          if (key === "length") continue;
          Object.defineProperty(output, key, copyDescriptor(descriptors[key]!, depth));
        }
        Object.defineProperty(output, "length", lengthDescriptor);
        Object.freeze(output);
        return output;
      }

      const output = Object.create(prototype) as Record<PropertyKey, unknown>;
      for (const key of keys) {
        Object.defineProperty(output, key, copyDescriptor(descriptors[key]!, depth));
      }
      Object.freeze(output);
      return output;
    } finally {
      active.delete(value);
    }
  };

  const copyDescriptor = (
    descriptor: PropertyDescriptor,
    depth: number,
  ): PropertyDescriptor => {
    if (!("value" in descriptor)) return descriptor;
    return {
      ...descriptor,
      value: copy(descriptor.value, depth + 1),
    };
  };

  return copy(input, 0);
}
