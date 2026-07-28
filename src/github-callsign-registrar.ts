import { readFile } from "node:fs/promises";
import {
  decideGitHubCallsignCommand,
  formatGitHubCallsignCommandRejection,
  formatGitHubCallsignReceipt,
  parseGitHubCallsignCommand,
  parseGitHubCallsignReceipt,
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

const githubApiVersion = "2022-11-28";
const registryIssueNumber = 454;

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
  if (!Number.isSafeInteger(commentId) || !body || !commentUrl || !author) {
    throw new Error("Issue comment event is missing required command fields");
  }
  if (author !== owner) {
    throw new Error("Callsign registrar accepts commands only from the repository owner during dogfood");
  }

  const client = new GitHubClient({ token, owner, repo });
  await client.addReaction(commentId, "eyes");

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
