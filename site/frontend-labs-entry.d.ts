export interface FrontendLabsEntryContract {
  readonly href: "/labs/";
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly action: string;
}

export const FRONTEND_LABS_ENTRY: Readonly<FrontendLabsEntryContract>;

export function installFrontendLabsEntry(documentRef?: Document): boolean;
