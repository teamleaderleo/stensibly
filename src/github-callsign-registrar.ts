import { readFile } from "node:fs/promises";
import {
  decideGitHubCallsignCommand,
  formatGitHubCallsignCommandRejection,
  formatGitHubCallsignReceipt,
  parseGitHubCallsignCommand,
  parseGitHubCallsignReceipt,
  projectGitHubCallsignRegistry,
  type ParsedGitHubCallsignReceipt,
} from "./github-callsign-registry.ts";

interface IssueCommentEvent {
  issue?: { number?: number };
  comment?: {
    id?: number;
    body?: string;
    html_url?: string;
    user?: { login?: string };
  };
  repository?: {
    owner?: { login?: string };
    name?: string;
    full_name?: string;
  };
}

interface GitHubIssueComment {
  id: number;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
}

export type GitHubCallsignMetaCommand = "help" | "status";

const githubApiVersion = "2022-11-28";
const registryIssueNumber = 454;
const statusLeaseLimit = 100;
const unsafeMetaTextPattern =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export async function runGitHubCallsignRegistrar(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const token = requiredEnv(env, "GITHUB_TOKEN");
  const eventPath = requiredEnv(env, "GITHUB_EVENT_PATH");
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must use owner/repo form");

  const event = JSON.parse(await readFile(eventPath, "utf8")) as IssueCommentEvent;
  const issueNumber = event.issue?.number;
  const commentId = event.comment?.id;
  const body = event.comment?.body;
  const commentUrl = event.comment?.html_url;
  const author = event.comment?.user?.login;

  if (issueNumber !== registryIssueNumber) {
    throw new Error(`Callsign registrar only accepts issue #${registryIssueNumber}`);
  }
  if (
    typeof commentId !== "number" || !Number.isSafeInteger(commentId)
    || !body || !commentUrl || !author
  ) {
    throw new Error("Issue comment event is missing required command fields");
  }
  if (author !== owner) {
    throw new Error("Callsign registrar accepts commands only from the repository owner during dogfood");
  }

  const client = new GitHubClient({ token, owner, repo });
  await client.addReaction(commentId, "eyes");

  const metaCommand = parseGitHubCallsignMetaCommand(body);
  if (metaCommand === "help") {
    await client.createIssueComment(issueNumber, formatGitHubCallsignHelp());
    await client.addReaction(commentId, "+1");
    return;
  }

  if (metaCommand === "status") {
    const receipts = await readCanonicalReceipts(client, issueNumber);
    await client.createIssueComment(
      issueNumber,
      formatGitHubCallsignStatus(receipts, new Date().toISOString()),
    );
    await client.addReaction(commentId, "+1");
    return;
  }

  let command;
  try {
    command = parseGitHubCallsignCommand(body);
  } catch (error) {
    await client.createIssueComment(
      issueNumber,
      formatGitHubCallsignCommandRejection({
        requestComment: commentUrl,
        reason: `invalid_command:${boundedError(error)}`,
      }),
    );
    await client.addReaction(commentId, "-1");
    return;
  }

  const receipts = await readCanonicalReceipts(client, issueNumber);
  const decision = decideGitHubCallsignCommand({
    command,
    requestComment: commentUrl,
    receipts,
    evaluatedAt: new Date().toISOString(),
  });

  if (decision.outcome !== "replay" && decision.receipt) {
    await client.createIssueComment(issueNumber, formatGitHubCallsignReceipt(decision.receipt));
  }
  await client.addReaction(commentId, decision.reaction);
}

export function parseGitHubCallsignMetaCommand(body: string): GitHubCallsignMetaCommand | null {
  if (typeof body !== "string" || unsafeMetaTextPattern.test(body)) return null;
  const normalized = body.replace(/\r\n/gu, "\n").trim();
  const firstParagraph = normalized.split(/\n\s*\n/u, 1)[0]?.trim() ?? "";
  if (firstParagraph === "/callsign help") return "help";
  if (firstParagraph === "/callsign status") return "status";
  return null;
}

export function formatGitHubCallsignHelp(): string {
  return [
    "callsign-help/v0",
    "",
    "Reserve a callsign:",
    "```text",
    "/callsign reserve <Callsign>",
    "run: run_<unique-run-id>",
    "session: <unique-worker-session-id>",
    "ttl: 24h",
    "```",
    "",
    "Release the exact active generation:",
    "```text",
    "/callsign release <Callsign>",
    "run: run_<current-holder-run-id>",
    "generation: <current-generation>",
    "```",
    "",
    "Show the live receipt projection:",
    "```text",
    "/callsign status",
    "```",
    "",
    "Worker quickstart: `docs/callsign-registry-dogfood.md`.",
    "",
    "`teamleaderleo` is the shared transport principal. Callsign, run, session, and accepted generation identify the worker attempt.",
  ].join("\n");
}

export function formatGitHubCallsignStatus(
  receipts: readonly ParsedGitHubCallsignReceipt[],
  evaluatedAt: string,
): string {
  const projection = projectGitHubCallsignRegistry(receipts, evaluatedAt);
  const visible = projection.activeLeases.slice(0, statusLeaseLimit);
  const omitted = Math.max(0, projection.activeLeases.length - visible.length);
  const lines = [
    "callsign-status/v0",
    `evaluated-at: ${projection.evaluatedAt}`,
    `active-count: ${projection.activeLeases.length}`,
    `shown-count: ${visible.length}`,
    `omitted-count: ${omitted}`,
    "",
  ];

  if (visible.length === 0) {
    lines.push("_No active callsign leases._");
  } else {
    lines.push(
      "| Callsign | Sigil | Run | Session | Generation | Expires | Receipt |",
      "| --- | --- | --- | --- | ---: | --- | --- |",
    );
    for (const lease of visible) {
      lines.push(
        `| ${tableCell(lease.callsign)} | ${tableCell(lease.sigil)} | \`${tableCell(lease.runId)}\` | \`${tableCell(lease.sessionId)}\` | ${lease.generation} | \`${tableCell(lease.expiresAt)}\` | [receipt](${lease.receiptCommentUrl}) |`,
      );
    }
  }

  lines.push(
    "",
    "This projection is reconstructed from valid `github-actions[bot]` receipts. GitHub username and reactions do not identify workers.",
  );
  return lines.join("\n");
}

async function readCanonicalReceipts(
  client: GitHubClient,
  issueNumber: number,
): Promise<ParsedGitHubCallsignReceipt[]> {
  const comments = await client.listIssueComments(issueNumber);
  const receipts: ParsedGitHubCallsignReceipt[] = [];
  for (const comment of comments) {
    if (comment.user?.login !== "github-actions[bot]" || !comment.body) continue;
    if (!comment.body.trimStart().startsWith("callsign-receipt/v0")) continue;
    try {
      receipts.push(parseGitHubCallsignReceipt({
        body: comment.body,
        commentId: comment.id,
        commentUrl: comment.html_url,
      }));
    } catch (error) {
      console.warn(`Ignoring malformed bot receipt ${comment.id}: ${boundedError(error)}`);
    }
  }
  return receipts;
}

class GitHubClient {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;

  constructor(input: { token: string; owner: string; repo: string }) {
    this.token = input.token;
    this.owner = input.owner;
    this.repo = input.repo;
  }

  async listIssueComments(issueNumber: number): Promise<GitHubIssueComment[]> {
    const comments: GitHubIssueComment[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request(
        `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      );
      const batch = await response.json() as GitHubIssueComment[];
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
    throw new Error("Callsign registry comment history exceeded 10,000 entries");
  }

  async createIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.request(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async addReaction(commentId: number, content: "eyes" | "+1" | "-1"): Promise<void> {
    await this.request(`/repos/${this.owner}/${this.repo}/issues/comments/${commentId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": githubApiVersion,
        "user-agent": "stensibly-callsign-registrar/v0",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`GitHub API ${response.status} for ${path}: ${detail}`);
    }
    return response;
  }
}

function requiredEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function tableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 200);
}

if (import.meta.main) {
  try {
    await runGitHubCallsignRegistrar();
  } catch (error) {
    console.error(boundedError(error));
    process.exitCode = 1;
  }
}
