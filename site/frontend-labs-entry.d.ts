export interface FrontendLabsEntryContract {
  readonly href: "/labs/";
  readonly label: string;
  readonly description: string;
}

export const FRONTEND_LABS_ENTRY: Readonly<FrontendLabsEntryContract>;

export function installFrontendLabsEntry(documentRef?: Document): boolean;
