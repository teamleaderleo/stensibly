from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label} drifted: expected 1 match, found {count}")
    return source.replace(old, new)


base = Path("src/github-rest-issue-write-adapter.ts")
source = base.read_text()
source = replace_once(source, '''import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import {
  canonicalBody,''', '''import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import { GitHubProviderPostEffectError } from "./github-provider-post-effect-error.js";
import {
  discardGitHubProviderResponse,
  readBoundedGitHubProviderResponseText,
} from "./github-provider-bounded-response.js";
import {
  canonicalBody,''', "base imports")
for operation, variable in [
    ("create issue", "issue"),
    ("update issue", "issue"),
    ("add issue comment", "comment"),
]:
    source = replace_once(
        source,
        f'const {variable} = admitMutationResult("{operation}", () =>',
        f'const {variable} = admitMutationResult("{operation}", providerRequestId, () =>',
        f"{operation} request attribution",
    )
source = replace_once(source, '''    const text = await boundedResponseText(response, input.operation);
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw ambiguousTransportError(input.operation);
      }
      throw new GitHubProviderRejectedError(
        "github_provider_request_rejected",
        `GitHub rejected ${input.operation}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      if (input.method !== "GET") {
        throw ambiguousMutationResult(input.operation);
      }
      throw invalidResponse(`GitHub ${input.operation} response was not valid JSON`);
    }
    if (!isRecord(value)) {
      if (input.method !== "GET") {
        throw ambiguousMutationResult(input.operation);
      }
      throw invalidResponse(`GitHub ${input.operation} response was malformed`);
    }
    const requestId = admittedRequestId(
      response.headers.get("x-github-request-id"),
    );
    return {
      value: value as T,
      ...(requestId ? { requestId } : {}),
    };''', '''    const requestId = admittedRequestId(
      response.headers.get("x-github-request-id"),
    );
    if (!response.ok) {
      await discardGitHubProviderResponse(response);
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        if (requestId && input.method !== "GET") {
          throw new GitHubProviderPostEffectError(requestId);
        }
        throw ambiguousTransportError(input.operation);
      }
      throw new GitHubProviderRejectedError(
        "github_provider_request_rejected",
        `GitHub rejected ${input.operation}`,
      );
    }
    let text: string;
    try {
      text = await readBoundedGitHubProviderResponseText(
        response,
        maximumResponseBytes,
      );
    } catch {
      if (requestId && input.method !== "GET") {
        throw new GitHubProviderPostEffectError(requestId);
      }
      throw ambiguousTransportError(input.operation);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      if (input.method !== "GET") {
        if (requestId) throw new GitHubProviderPostEffectError(requestId);
        throw ambiguousMutationResult(input.operation);
      }
      throw invalidResponse(`GitHub ${input.operation} response was not valid JSON`);
    }
    if (!isRecord(value)) {
      if (input.method !== "GET") {
        if (requestId) throw new GitHubProviderPostEffectError(requestId);
        throw ambiguousMutationResult(input.operation);
      }
      throw invalidResponse(`GitHub ${input.operation} response was malformed`);
    }
    return {
      value: value as T,
      ...(requestId ? { requestId } : {}),
    };''', "base response boundary")
source = replace_once(source, '''async function boundedResponseText(
  response: Response,
  operation: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\\d+$/.test(contentLength)) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maximumResponseBytes) {
      throw ambiguousTransportError(operation);
    }
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw ambiguousTransportError(operation);
  }
  if (Buffer.byteLength(text, "utf8") > maximumResponseBytes) {
    throw ambiguousTransportError(operation);
  }
  return text;
}

''', "", "remove base unbounded reader")
source = replace_once(source, '''function admitMutationResult<T>(operation: string, admit: () => T): T {
  try {
    return admit();
  } catch {
    throw ambiguousMutationResult(operation);
  }
}''', '''function admitMutationResult<T>(
  operation: string,
  providerRequestId: string,
  admit: () => T,
): T {
  try {
    return admit();
  } catch {
    throw new GitHubProviderPostEffectError(providerRequestId);
  }
}''', "base schema attribution")
base.write_text(source)

sets = Path("src/github-rest-issue-set-write-adapter.ts")
source = sets.read_text()
source = replace_once(source, '''import { GitHubProviderPostEffectError } from "./github-provider-post-effect-error.js";
import {''', '''import { GitHubProviderPostEffectError } from "./github-provider-post-effect-error.js";
import {
  discardGitHubProviderResponse,
  readBoundedGitHubProviderResponseText,
} from "./github-provider-bounded-response.js";
import {''', "set imports")
source = replace_once(source, '''    admitMutationResponse(input.operation, () =>
      input.admitResponse(response.value, repositoryFullName, issueNumber)
    );''', '''    admitMutationResponse(input.operation, response.requestId, () =>
      input.admitResponse(response.value, repositoryFullName, issueNumber)
    );''', "set schema attribution")
source = replace_once(source, '''    const text = await boundedResponseText(response, input.operation);
    if (!response.ok) {
      if (
        response.status >= 500
        || response.status === 408
        || response.status === 429
      ) {
        throw ambiguousTransportError(input.operation);
      }
      throw new GitHubProviderRejectedError(
        "github_provider_request_rejected",
        `GitHub rejected ${input.operation}`,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw ambiguousMutationResult(input.operation);
    }
    const requestId = admittedRequestId(
      response.headers.get("x-github-request-id"),
    );
    if (!requestId) throw ambiguousMutationResult(input.operation);
    return { requestId, value };''', '''    const requestId = admittedRequestId(
      response.headers.get("x-github-request-id"),
    );
    if (!response.ok) {
      await discardGitHubProviderResponse(response);
      if (
        response.status >= 500
        || response.status === 408
        || response.status === 429
      ) {
        if (requestId) throw new GitHubProviderPostEffectError(requestId);
        throw ambiguousTransportError(input.operation);
      }
      throw new GitHubProviderRejectedError(
        "github_provider_request_rejected",
        `GitHub rejected ${input.operation}`,
      );
    }

    let text: string;
    try {
      text = await readBoundedGitHubProviderResponseText(
        response,
        maximumResponseBytes,
      );
    } catch {
      if (requestId) throw new GitHubProviderPostEffectError(requestId);
      throw ambiguousTransportError(input.operation);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      if (requestId) throw new GitHubProviderPostEffectError(requestId);
      throw ambiguousMutationResult(input.operation);
    }
    if (!requestId) throw ambiguousMutationResult(input.operation);
    return { requestId, value };''', "set response boundary")
source = replace_once(source, '''function admitMutationResponse(operation: string, admit: () => void): void {
  try {
    admit();
  } catch {
    throw ambiguousMutationResult(operation);
  }
}''', '''function admitMutationResponse(
  operation: string,
  providerRequestId: string,
  admit: () => void,
): void {
  try {
    admit();
  } catch {
    throw new GitHubProviderPostEffectError(providerRequestId);
  }
}''', "set response schema attribution")
source = replace_once(source, '''async function boundedResponseText(
  response: Response,
  operation: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\\d+$/.test(contentLength)) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maximumResponseBytes) {
      throw ambiguousTransportError(operation);
    }
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw ambiguousTransportError(operation);
  }
  if (Buffer.byteLength(text, "utf8") > maximumResponseBytes) {
    throw ambiguousTransportError(operation);
  }
  return text;
}

''', "", "remove set unbounded reader")
sets.write_text(source)
