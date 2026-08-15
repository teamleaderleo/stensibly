import type { MailDigestProjection } from "./mail-ux-projection.ts";

export interface MaterialDigestMessage {
  launchLine: string;
  body: string;
  bodyBytes: number;
  authorizesOperation: false;
  authorizesMutation: false;
}

const encoder = new TextEncoder();

export function renderMailDigestMessage(
  digest: MailDigestProjection,
): MaterialDigestMessage {
  const launchLine = "Read the latest Stensibly digest and continue one useful lane.";
  const rows = digest.rows.map((row) =>
    `${row.temperature.toUpperCase()} · ${row.handle} · ${row.ageHours}h · ${row.title}\nState: ${row.current}\nNext: ${row.nextAction}\nSource: ${row.strongestSource}`
  );
  const body = [
    launchLine,
    "",
    ...rows,
  ].join("\n\n");

  return Object.freeze({
    launchLine,
    body,
    bodyBytes: encoder.encode(body).byteLength,
    authorizesOperation: false,
    authorizesMutation: false,
  });
}
