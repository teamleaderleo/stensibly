export function readSemanticClaimGeneration(
  body: Element,
  expectedItemId?: string,
): number | null;

export function installSemanticGenerationController(): {
  reset(): void;
} | null;
