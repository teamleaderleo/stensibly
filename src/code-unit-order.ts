/**
 * Compares strings by exact UTF-16 code units for deterministic canonical
 * ordering. This intentionally avoids locale- and runtime-sensitive collation.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
