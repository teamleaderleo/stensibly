const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const attemptStates = new Set(["queued", "reserved", "starting", "running", "verifying", "waiting_external", "stalled", "cancelling", "cancelled", "blocked", "succeeded", "failed"]);
const attentionReasons = new Set(["human_decision", "ambiguous_settlement", "heartbeat_missed", "lease_expired", "external_wait_old", "verification_failed", "superseded_current", "blocked", "stalled", "failed", "stale_receipt", "high_fan_out"]);
const relationKinds = new Set(["dependency", "stacked_candidate", "file_overlap", "contract_overlap", "shared_external_gate", "supersedes", "handoff"]);
const eventKinds = new Set(["admitted", "reserved", "started", "receipt", "candidate", "verification", "wait", "stalled", "decision", "reconciliation", "superseded", "terminal"]);
const viewIds = new Set(["list", "lanes", "attention", "polar", "timeline"]);
const consequenceClasses = new Set(["tier_0", "tier_1", "tier_2", "tier_3"]);
const attemptKeys = ["artifact", "attentionReasons", "authorityGeneration", "blockedFanOut", "callsign", "candidate", "consequence", "evidence", "id", "itemId", "nextAction", "outcomeId", "phase", "polar", "profile", "queuePosition", "receiptAgeMinutes", "receiptLabel", "runId", "state"];
const polarKeys = ["angleDegrees", "blockedFanOut", "freshnessRing", "lane", "receiptAgeMinutes"];
const relationKeys = ["evidence", "from", "id", "kind", "label", "to"];
const attentionKeys = ["attemptId", "evidence", "id", "label", "nextAction", "reason"];
const eventKeys = ["at", "attemptId", "evidence", "id", "kind", "label"];
const viewKeys = ["id", "label", "purpose"];
const taskKeys = ["id", "prompt", "start", "success"];

const sourceFixture = {
  observedAt: "2026-07-31T10:30:00.000Z",
  attempts: [
    {
      id: "sable-overlay", outcomeId: "assurance-overlays", itemId: "issue-510", runId: "run-sable-44", authorityGeneration: 4,
      callsign: "Sable", profile: "codex-gpt-5-6-thinking", state: "running", phase: "selector-repair", receiptAgeMinutes: 1,
      receiptLabel: "Exact source receipt", candidate: "4eb1a03", artifact: null, queuePosition: null, attentionReasons: [], blockedFanOut: 0,
      nextAction: "Wait for exact-head CI, then refresh the integration verdict.", evidence: "github-pr-692-head-4eb1a03", consequence: "tier_1",
      polar: { lane: "assurance-overlays", angleDegrees: 0, receiptAgeMinutes: 1, freshnessRing: "current", blockedFanOut: 0 },
    },
    {
      id: "mist-ci-receipt", outcomeId: "ci-admission", itemId: "issue-700", runId: "run-mist-18", authorityGeneration: 2,
      callsign: "Mist", profile: "github-actions-ubuntu-24-04", state: "queued", phase: "runner-admission", receiptAgeMinutes: 12,
      receiptLabel: "GitHub run receipt", candidate: "97d3499", artifact: null, queuePosition: "unknown", attentionReasons: [], blockedFanOut: 0,
      nextAction: "Start the canonical jobs when GitHub assigns capacity.", evidence: "github-run-30625097409", consequence: "tier_1",
      polar: { lane: "ci-admission", angleDegrees: 60, receiptAgeMinutes: 12, freshnessRing: "current", blockedFanOut: 0 },
    },
    {
      id: "juniper-execution", outcomeId: "execution-certainty", itemId: "issue-572", runId: "run-juniper-31", authorityGeneration: 5,
      callsign: "Juniper", profile: "github-actions-ubuntu-24-04", state: "waiting_external", phase: "hosted-ci", receiptAgeMinutes: 38,
      receiptLabel: "External gate receipt", candidate: "8fdf697", artifact: null, queuePosition: "unknown", attentionReasons: ["external_wait_old", "stale_receipt"], blockedFanOut: 1,
      nextAction: "Refresh the GitHub run and publish the source-only head after the finalizer completes.", evidence: "github-pr-578-run-30601434211", consequence: "tier_2",
      polar: { lane: "execution-certainty", angleDegrees: 120, receiptAgeMinutes: 38, freshnessRing: "stale", blockedFanOut: 1 },
    },
    {
      id: "ember-runtime", outcomeId: "runtime-adapter", itemId: "pr-659", runId: "run-ember-22", authorityGeneration: 7,
      callsign: "Ember", profile: "openai-agents-sdk", state: "stalled", phase: "checkpoint-review", receiptAgeMinutes: 46,
      receiptLabel: "Missed heartbeat receipt", candidate: "ec93e29", artifact: null, queuePosition: null, attentionReasons: ["lease_expired", "heartbeat_missed", "stalled", "stale_receipt"], blockedFanOut: 2,
      nextAction: "Bind executable graph identity and validate the observation clock before restart.", evidence: "github-pr-659-review-blockers", consequence: "tier_2",
      polar: { lane: "runtime-adapter", angleDegrees: 180, receiptAgeMinutes: 46, freshnessRing: "stale", blockedFanOut: 2 },
    },
    {
      id: "cedar-operation", outcomeId: "remote-settlement", itemId: "operation-84", runId: "run-cedar-09", authorityGeneration: 3,
      callsign: "Cedar", profile: "github-provider", state: "blocked", phase: "reconciliation", receiptAgeMinutes: 6,
      receiptLabel: "Ambiguous operation receipt", candidate: null, artifact: "sha256-111111111111", queuePosition: null, attentionReasons: ["ambiguous_settlement", "blocked"], blockedFanOut: 0,
      nextAction: "Read the exact remote operation receipt before replay.", evidence: "operation-receipt-sha256-111111111111", consequence: "tier_2",
      polar: { lane: "remote-settlement", angleDegrees: 240, receiptAgeMinutes: 6, freshnessRing: "current", blockedFanOut: 0 },
    },
    {
      id: "violet-review", outcomeId: "frontend-parity", itemId: "pr-664", runId: "run-violet-13", authorityGeneration: 2,
      callsign: "Violet", profile: "codex-review", state: "blocked", phase: "integration-decision", receiptAgeMinutes: 3,
      receiptLabel: "Human decision request", candidate: "53c9a90", artifact: null, queuePosition: null, attentionReasons: ["human_decision", "blocked"], blockedFanOut: 0,
      nextAction: "Inspect the exact diff and record the merge decision.", evidence: "github-pr-664-decision-request", consequence: "tier_2",
      polar: { lane: "frontend-parity", angleDegrees: 300, receiptAgeMinutes: 3, freshnessRing: "current", blockedFanOut: 0 },
    },
    {
      id: "moss-dependency", outcomeId: "github-read-path", itemId: "issue-585", runId: "run-moss-27", authorityGeneration: 6,
      callsign: "Moss", profile: "github-app-read-provider", state: "blocked", phase: "shared-dependency", receiptAgeMinutes: 8,
      receiptLabel: "Dependency receipt", candidate: "aebb892", artifact: null, queuePosition: null, attentionReasons: ["blocked", "high_fan_out"], blockedFanOut: 3,
      nextAction: "Clear the shared provider admission gate for the three downstream lanes.", evidence: "github-issue-585-dependency-receipt", consequence: "tier_2",
      polar: { lane: "github-read-path", angleDegrees: 30, receiptAgeMinutes: 8, freshnessRing: "current", blockedFanOut: 3 },
    },
    {
      id: "old-sable", outcomeId: "assurance-overlays", itemId: "issue-510", runId: "run-sable-39", authorityGeneration: 3,
      callsign: "Sable", profile: "codex-gpt-5-6-thinking", state: "cancelled", phase: "terminal", receiptAgeMinutes: 91,
      receiptLabel: "Superseded terminal receipt", candidate: "d8159d6", artifact: null, queuePosition: null, attentionReasons: [], blockedFanOut: 0,
      nextAction: "Open the successor attempt.", evidence: "github-pr-692-superseded-head", consequence: "tier_1",
      polar: { lane: "assurance-overlays", angleDegrees: 0, receiptAgeMinutes: 91, freshnessRing: "stale", blockedFanOut: 0 },
    },
  ],
  relations: [
    { id: "rel-overlay-supersedes", kind: "supersedes", from: "sable-overlay", to: "old-sable", label: "Current selector repair supersedes the pre-repair head.", evidence: "github-pr-692-head-lineage" },
    { id: "rel-provider-runtime", kind: "dependency", from: "moss-dependency", to: "ember-runtime", label: "The runtime lane consumes the accepted provider admission boundary.", evidence: "github-issue-585-runtime-dependency" },
    { id: "rel-provider-execution", kind: "stacked_candidate", from: "moss-dependency", to: "juniper-execution", label: "The execution receipt stack waits on the shared read authority.", evidence: "github-issue-585-execution-stack" },
    { id: "rel-provider-review", kind: "contract_overlap", from: "moss-dependency", to: "violet-review", label: "Both lanes consume the same delegated-read contract.", evidence: "github-issue-585-contract-overlap" },
    { id: "rel-ci-shared-gate", kind: "shared_external_gate", from: "mist-ci-receipt", to: "juniper-execution", label: "Both attempts wait on hosted GitHub runner admission.", evidence: "github-actions-shared-capacity" },
    { id: "rel-runtime-overlap", kind: "file_overlap", from: "ember-runtime", to: "cedar-operation", label: "Checkpoint recovery and settlement touch one recovery contract.", evidence: "runtime-settlement-overlap" },
    { id: "rel-review-handoff", kind: "handoff", from: "old-sable", to: "sable-overlay", label: "The repaired attempt continues the prior exact handoff.", evidence: "github-pr-692-handoff" },
  ],
  attention: [
    { id: "attention-human-decision", attemptId: "violet-review", reason: "human_decision", label: "One merge decision is ready.", nextAction: "Inspect the exact candidate and record the decision.", evidence: "github-pr-664-decision-request" },
    { id: "attention-ambiguous", attemptId: "cedar-operation", reason: "ambiguous_settlement", label: "Remote mutation outcome remains ambiguous.", nextAction: "Reconcile the exact operation receipt before replay.", evidence: "operation-receipt-sha256-111111111111" },
    { id: "attention-lease", attemptId: "ember-runtime", reason: "lease_expired", label: "The runtime attempt lease expired.", nextAction: "Review the handoff and start a fresh generation.", evidence: "github-pr-659-review-blockers" },
    { id: "attention-fanout", attemptId: "moss-dependency", reason: "high_fan_out", label: "One dependency blocks three downstream attempts.", nextAction: "Clear the shared provider admission gate.", evidence: "github-issue-585-dependency-receipt" },
    { id: "attention-external", attemptId: "juniper-execution", reason: "external_wait_old", label: "Hosted CI wait crossed the attention threshold.", nextAction: "Refresh the exact GitHub run.", evidence: "github-pr-578-run-30601434211" },
  ],
  events: [
    { id: "event-overlay-admitted", attemptId: "sable-overlay", at: "2026-07-31T09:50:00.000Z", kind: "admitted", label: "Exact selector repair admitted.", evidence: "github-pr-692-admission" },
    { id: "event-overlay-candidate", attemptId: "sable-overlay", at: "2026-07-31T10:29:00.000Z", kind: "candidate", label: "Current candidate head published.", evidence: "github-pr-692-head-4eb1a03" },
    { id: "event-ci-wait", attemptId: "mist-ci-receipt", at: "2026-07-31T10:18:00.000Z", kind: "wait", label: "Canonical jobs entered the hosted queue.", evidence: "github-run-30625097409" },
    { id: "event-runtime-stalled", attemptId: "ember-runtime", at: "2026-07-31T09:44:00.000Z", kind: "stalled", label: "Heartbeat and lease evidence expired.", evidence: "github-pr-659-review-blockers" },
    { id: "event-operation-reconcile", attemptId: "cedar-operation", at: "2026-07-31T10:24:00.000Z", kind: "reconciliation", label: "Replay held for remote reconciliation.", evidence: "operation-receipt-sha256-111111111111" },
    { id: "event-review-decision", attemptId: "violet-review", at: "2026-07-31T10:27:00.000Z", kind: "decision", label: "Exact merge decision requested.", evidence: "github-pr-664-decision-request" },
    { id: "event-old-superseded", attemptId: "old-sable", at: "2026-07-31T09:05:00.000Z", kind: "superseded", label: "Pre-repair head superseded.", evidence: "github-pr-692-head-lineage" },
  ],
  views: [
    { id: "list", label: "Work pulse", purpose: "Scan literal attempt identity, state, receipt age, and next action." },
    { id: "lanes", label: "Work lanes", purpose: "Trace declared dependencies, overlaps, stacks, supersession, and handoffs." },
    { id: "attention", label: "Attention ledger", purpose: "Rank concrete decisions, ambiguity, stale evidence, and fan-out." },
    { id: "polar", label: "Attention polar", purpose: "Scan receipt age and fan-out across durable outcome lanes." },
    { id: "timeline", label: "Evidence scrubber", purpose: "Scrub accepted transitions and open their evidence records." },
  ],
};

const sourceTasks = [
  { id: "active-attempts", prompt: "Identify every current active attempt and its exact candidate or artifact.", start: "list", success: "sable-overlay,mist-ci-receipt,juniper-execution,ember-runtime,cedar-operation,violet-review,moss-dependency" },
  { id: "external-wait", prompt: "Distinguish source work from the attempt waiting on hosted CI.", start: "list", success: "juniper-execution" },
  { id: "human-decision", prompt: "Find the only explicit human decision and its safe next action.", start: "attention", success: "violet-review" },
  { id: "fan-out", prompt: "Find the blocker with the highest declared downstream fan-out.", start: "polar", success: "moss-dependency" },
  { id: "stale-receipt", prompt: "Explain why the runtime attempt is stale without using animation or chat presence.", start: "attention", success: "ember-runtime" },
  { id: "reconciliation", prompt: "Locate the ambiguous operation and the action that avoids blind replay.", start: "attention", success: "cedar-operation" },
  { id: "supersession", prompt: "Trace the repaired assurance attempt back to the superseded run.", start: "lanes", success: "rel-overlay-supersedes" },
  { id: "shared-gate", prompt: "Find two attempts waiting on the same external runner gate.", start: "lanes", success: "rel-ci-shared-gate" },
  { id: "receipt-history", prompt: "Open the event that published the current assurance candidate.", start: "timeline", success: "event-overlay-candidate" },
  { id: "same-callsign", prompt: "Show why two Sable rows represent separate attempts.", start: "list", success: "sable-overlay,old-sable" },
];

export const workPulseFixture = parseWorkPulseFixture(sourceFixture);
export const workPulseFixtureTasks = parseWorkPulseFixtureTasks(sourceTasks);

export function parseWorkPulseFixture(value) {
  exactRecord(value, ["attempts", "attention", "events", "observedAt", "relations", "views"], "Work Pulse fixture");
  const observedAt = timestamp(value.observedAt, "Fixture observation");
  const attempts = parseList(value.attempts, 1, 40, parseAttempt);
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  unique(attempts.map((attempt) => attempt.id), "attempt ids");
  const relations = parseList(value.relations, 0, 100, parseRelation);
  const attention = parseList(value.attention, 0, 100, parseAttention);
  const events = parseList(value.events, 0, 200, parseEvent);
  const views = parseList(value.views, 5, 5, parseView);
  unique(relations.map((relation) => relation.id), "relation ids");
  unique(relations.map((relation) => `${relation.kind}:${relation.from}:${relation.to}`), "semantic relations");
  unique(attention.map((entry) => entry.id), "attention ids");
  unique(events.map((event) => event.id), "event ids");
  unique(views.map((view) => view.id), "view ids");
  for (const relation of relations) {
    if (!attemptIds.has(relation.from) || !attemptIds.has(relation.to)) throw new TypeError(`Unknown attempt in relation ${relation.id}`);
    if (relation.from === relation.to) throw new TypeError(`Self relation: ${relation.id}`);
  }
  for (const entry of attention) {
    const attempt = attemptsById.get(entry.attemptId);
    if (!attempt) throw new TypeError(`Unknown attempt in attention ${entry.id}`);
    if (!attempt.attentionReasons.includes(entry.reason)) {
      throw new TypeError(`Attention reason ${entry.reason} is absent from attempt ${entry.attemptId}`);
    }
  }
  for (const event of events) {
    if (!attemptIds.has(event.attemptId)) throw new TypeError(`Unknown attempt in event ${event.id}`);
    if (event.at > observedAt) throw new TypeError(`Event ${event.id} follows fixture observation`);
  }
  return deepFreeze({ observedAt, attempts, relations, attention, events, views });
}

export function parseWorkPulseFixtureTasks(value) {
  const tasks = parseList(value, 1, 30, (entry, index) => {
    exactRecord(entry, taskKeys, `Work Pulse task ${index + 1}`);
    return Object.freeze({ id: slug(entry.id, "Task id"), prompt: text(entry.prompt, 220, "Task prompt"), start: closed(entry.start, viewIds, "Task start"), success: text(entry.success, 200, "Task success") });
  });
  unique(tasks.map((task) => task.id), "task ids");
  return Object.freeze(tasks);
}

function parseAttempt(value, index) {
  exactRecord(value, attemptKeys, `Work Pulse attempt ${index + 1}`);
  const queuePosition = value.queuePosition === null || value.queuePosition === "unknown" ? value.queuePosition : integer(value.queuePosition, 1, 1000000, "Queue position");
  if (value.state !== "queued" && value.state !== "waiting_external" && queuePosition !== null) throw new TypeError("Only queued or external-wait attempts may carry queue position");
  const reasons = parseList(value.attentionReasons, 0, 12, (reason) => closed(reason, attentionReasons, "Attention reason"));
  unique(reasons, "attention reasons");
  const polar = parsePolar(value.polar);
  if (polar.receiptAgeMinutes !== value.receiptAgeMinutes || polar.blockedFanOut !== value.blockedFanOut || polar.lane !== value.outcomeId) throw new TypeError("Polar identity must match the attempt");
  return deepFreeze({
    id: slug(value.id, "Attempt id"), outcomeId: slug(value.outcomeId, "Outcome id"), itemId: slug(value.itemId, "Item id"), runId: slug(value.runId, "Run id"),
    authorityGeneration: integer(value.authorityGeneration, 1, Number.MAX_SAFE_INTEGER, "Authority generation"), callsign: text(value.callsign, 60, "Callsign"),
    profile: slug(value.profile, "Profile"), state: closed(value.state, attemptStates, "Attempt state"), phase: slug(value.phase, "Attempt phase"),
    receiptAgeMinutes: integer(value.receiptAgeMinutes, 0, 1000000, "Receipt age"), receiptLabel: text(value.receiptLabel, 120, "Receipt label"),
    candidate: nullableRevision(value.candidate, "Candidate"), artifact: nullableIdentifier(value.artifact, "Artifact"), queuePosition,
    attentionReasons: reasons, blockedFanOut: integer(value.blockedFanOut, 0, 1000, "Blocked fan-out"), nextAction: text(value.nextAction, 320, "Next action"),
    evidence: identifier(value.evidence, "Evidence"), consequence: closed(value.consequence, consequenceClasses, "Consequence"), polar,
  });
}
function parsePolar(value) { exactRecord(value, polarKeys, "Work Pulse polar coordinate"); return Object.freeze({ lane: slug(value.lane, "Polar lane"), angleDegrees: integer(value.angleDegrees, 0, 359, "Polar angle"), receiptAgeMinutes: integer(value.receiptAgeMinutes, 0, 1000000, "Polar receipt age"), freshnessRing: closed(value.freshnessRing, new Set(["current", "stale"]), "Freshness ring"), blockedFanOut: integer(value.blockedFanOut, 0, 1000, "Polar blocked fan-out") }); }
function parseRelation(value, index) { exactRecord(value, relationKeys, `Work Pulse relation ${index + 1}`); return Object.freeze({ id: slug(value.id, "Relation id"), kind: closed(value.kind, relationKinds, "Relation kind"), from: slug(value.from, "Relation source"), to: slug(value.to, "Relation target"), label: text(value.label, 240, "Relation label"), evidence: identifier(value.evidence, "Relation evidence") }); }
function parseAttention(value, index) { exactRecord(value, attentionKeys, `Work Pulse attention ${index + 1}`); return Object.freeze({ id: slug(value.id, "Attention id"), attemptId: slug(value.attemptId, "Attention attempt"), reason: closed(value.reason, attentionReasons, "Attention reason"), label: text(value.label, 240, "Attention label"), nextAction: text(value.nextAction, 320, "Attention next action"), evidence: identifier(value.evidence, "Attention evidence") }); }
function parseEvent(value, index) { exactRecord(value, eventKeys, `Work Pulse event ${index + 1}`); return Object.freeze({ id: slug(value.id, "Event id"), attemptId: slug(value.attemptId, "Event attempt"), at: timestamp(value.at, "Event time"), kind: closed(value.kind, eventKinds, "Event kind"), label: text(value.label, 240, "Event label"), evidence: identifier(value.evidence, "Event evidence") }); }
function parseView(value, index) { exactRecord(value, viewKeys, `Work Pulse view ${index + 1}`); return Object.freeze({ id: closed(value.id, viewIds, "View id"), label: text(value.label, 80, "View label"), purpose: text(value.purpose, 240, "View purpose") }); }
function parseList(value, minimum, maximum, parser) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum) {
    throw new TypeError(`Expected ${minimum}-${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError("Array contains a symbol field");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (key !== "length" && (!/^\d+$/u.test(key) || Number(key) >= value.length)) {
      throw new TypeError(`Array contains unknown field ${key}`);
    }
  }
  const parsed = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) throw new TypeError("Array must be dense");
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`Array entry ${index} must be an enumerable data property`);
    }
    parsed.push(parser(descriptor.value, index));
  }
  return Object.freeze(parsed);
}
function exactRecord(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be an object`); if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${label} contains a symbol field`); const descriptors = Object.getOwnPropertyDescriptors(value); for (const [key, descriptor] of Object.entries(descriptors)) { if (!keys.includes(key)) throw new TypeError(`${label} contains unknown field ${key}`); if (!descriptor.enumerable || !("value" in descriptor)) throw new TypeError(`${label} field ${key} must be data`); } if (Object.keys(descriptors).sort().join(",") !== [...keys].sort().join(",")) throw new TypeError(`${label} must use exact fields`); }
function closed(value, allowed, label) { if (typeof value !== "string" || !allowed.has(value)) throw new TypeError(`${label} is unsupported`); return value; }
function unique(values, label) { if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${label}`); }
function integer(value, minimum, maximum, label) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} is invalid`); return value; }
function nullableRevision(value, label) { if (value === null) return null; if (typeof value !== "string" || !/^[a-f0-9]{7,40}$/u.test(value)) throw new TypeError(`${label} is invalid`); return value; }
function nullableIdentifier(value, label) { return value === null ? null : identifier(value, label); }
function identifier(value, label) { const normalized = text(value, 200, label); if (!/^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/u.test(normalized)) throw new TypeError(`${label} is invalid`); return normalized; }
function slug(value, label) { const normalized = text(value, 100, label); if (!idPattern.test(normalized)) throw new TypeError(`${label} must be a lowercase slug`); return normalized; }
function timestamp(value, label) { const normalized = text(value, 30, label); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized) || new Date(normalized).toISOString() !== normalized) throw new TypeError(`${label} must be canonical UTC`); return normalized; }
function text(value, maximum, label) { if (typeof value !== "string") throw new TypeError(`${label} must be text`); const normalized = value.trim(); if (!normalized || normalized.length > maximum || unsafeTextPattern.test(normalized)) throw new TypeError(`${label} must contain 1-${maximum} safe characters`); return normalized; }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const nested of Object.values(value)) deepFreeze(nested); } return value; }
