import type {
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import { canonicalLogins } from "./github-provider-validation.js";

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
    addIssueAssignees(input: Parameters<GitHubIssueProviderSetWriteService["addIssueAssignees"]>[0]) {
      const assignees = admittedAssigneeMutation(input.assignees);
      return service.addIssueAssignees({ ...input, assignees });
    },
    removeIssueAssignees(input: Parameters<GitHubIssueProviderSetWriteService["removeIssueAssignees"]>[0]) {
      const assignees = admittedAssigneeMutation(input.assignees);
      return service.removeIssueAssignees({ ...input, assignees });
    },
  });
}

function admittedAssigneeMutation(values: string[]): string[] {
  const assignees = canonicalLogins(values);
  if (assignees.length === 0 || assignees.length > 10) {
    throw new RangeError(
      "GitHub issue assignee mutation requires 1 to 10 unique assignees",
    );
  }
  return assignees;
}
