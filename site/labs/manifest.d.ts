/** Static, fixture-only frontend lab identities shared by the catalogue and source contracts. */
export type FrontendLabStatus = "planned" | "prototype";

export type FrontendLabSupport =
  | "wide"
  | "medium"
  | "narrow"
  | "light"
  | "dark"
  | "keyboard"
  | "reduced-motion"
  | "loading"
  | "empty"
  | "degraded"
  | "error";

export interface FrontendLabVariant {
  readonly id: string;
  readonly title: string;
  readonly thesis: string;
  readonly owner: string;
  readonly status: FrontendLabStatus;
  readonly revision: string | null;
  readonly issue: number;
  readonly path: string;
  readonly support: readonly FrontendLabSupport[];
}

export const frontendLabManifest: readonly FrontendLabVariant[];

export function parseFrontendLabManifest(value: unknown): readonly FrontendLabVariant[];

export function frontendLabVariantById(
  manifest: unknown,
  id: string,
): FrontendLabVariant | null;
