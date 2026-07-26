import {
  parseExecutionEnvelope,
  type ExecutionEnvelope,
} from "./execution-envelope.js";

export function compatibilityExecutionEnvelope(objective: string): ExecutionEnvelope {
  return parseExecutionEnvelope({
    schemaVersion: 1,
    objective,
    scopeClass: "atomic",
    estimate: {
      lowMinutes: 15,
      likelyMinutes: 30,
      highMinutes: 60,
      confidence: 0.25,
    },
    budget: {
      expectedMessages: 2,
      expectedToolCalls: 25,
      expectedReviewMinutes: 5,
    },
    boundaries: {
      softCheckpointMinutes: 45,
      forcedHandoffMinutes: 60,
      hardRecoveryMinutes: 90,
    },
    completion: {
      requiredOutputs: ["work result", "durable outcome"],
      verificationRequired: true,
      continuationStateRequired: true,
      acceptanceChecks: ["run records a verified outcome or continuation state"],
    },
    durableState: {
      accessClass: "project",
      retentionClass: "standard",
      redactionRequired: true,
      deleteAfter: null,
    },
  });
}
