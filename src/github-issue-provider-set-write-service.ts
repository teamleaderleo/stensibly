import type {
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";

export interface GitHubIssueProviderSetWriteService {
  addIssueLabels(input: GitHubProviderRequestContext & {
    issueNumber: number;
    labels: string[];
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
  removeIssueLabel(input: GitHubProviderRequestContext & {
    issueNumber: number;
    label: string;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
  addIssueAssignees(input: GitHubProviderRequestContext & {
    issueNumber: number;
    assignees: string[];
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
  removeIssueAssignees(input: GitHubProviderRequestContext & {
    issueNumber: number;
    assignees: string[];
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
}

export function withGitHubIssueProviderSetWriteService<T extends object>(
  target: T,
  service: GitHubIssueProviderSetWriteService,
): T & GitHubIssueProviderSetWriteService {
  return Object.assign(target, {
    addIssueLabels: service.addIssueLabels.bind(service),
    removeIssueLabel: service.removeIssueLabel.bind(service),
    addIssueAssignees: service.addIssueAssignees.bind(service),
    removeIssueAssignees: service.removeIssueAssignees.bind(service),
  });
}
