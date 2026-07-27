export function hostedSessionSentinel(): string;

export function isHostedSessionSentinel(value: unknown): boolean;

export function createGithubSignInUrl(endpoint: string, returnTo: string): string;

export function createHostedLogoutUrl(endpoint: string): string;

export function prepareHostedSessionRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  sessionOrigin: string,
  sentinel?: string,
): Request;

export function installHostedSessionFetchBridge(options: {
  fetchImpl: typeof fetch;
  sessionOrigin: string;
  sentinel?: string;
}): typeof fetch;
