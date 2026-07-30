import "./github-provider-validation.js";

declare module "./github-provider-validation.js" {
  export function positiveInteger(value: unknown, label: string): number;
}
