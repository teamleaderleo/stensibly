export interface HostedSessionPreparedRequest {
  request: Request;
  credentials: RequestCredentials;
  hostedSession: boolean;
}

export function hostedSessionSentinel(): string;

export function isHostedSessionSentinel(value: unknown): boolean;

export function classifyHostedSessionDisconnect(
  storedToken: unknown,
  hostedAuthorizationDenied: boolean,
): "ordinary" | "hosted" | "bearer";

export function isDefaultHostedEndpoint(endpoint: string, defaultEndpoint: string): boolean;

export function createGithubSignInUrl(endpoint: string, returnTo: string): string;

export function createHostedLogoutUrl(endpoint: string): string;

export function revokeHostedSession(fetchImpl: typeof fetch, endpoint: string): Promise<void>;

export function prepareHostedSessionRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  sessionOrigin: string,
  sentinel?: string,
): HostedSessionPreparedRequest;

export function installHostedSessionFetchBridge(options: {
  fetchImpl: typeof fetch;
  sessionOrigin: string;
  sentinel?: string;
  onHostedAccessDenied?: () => void;
}): typeof fetch;
