export function hostedSessionSentinel(): string;

export function isHostedSessionSentinel(value: unknown): boolean;

export function createGithubSignInUrl(endpoint: string, returnTo: string): string;

export function createHostedLogoutUrl(endpoint: string): string;

export function prepareHostedSessionRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
  sentinel?: string,
): Request;

export function installHostedSessionFetchBridge(options: {
  fetchImpl: typeof fetch;
  sentinel?: string;
}): typeof fetch;
