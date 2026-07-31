const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
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
  observedAt: "2026-01-15T10:30:00.000Z",
  attempts: [
    {
      id: "moss-accessibility", outcomeId: "keyboard-evidence", itemId: "item-keyboard-evidence", runId: "run-moss-04", authorityGeneration: 4,
      callsign: "Moss", profile: "review-worker", state: "running", phase: "evidence-review", receiptAgeMinutes: 1,
      receiptLabel: "Exact source receipt", candidate: "7ac91de", artifact: null, queuePosition: null, attentionReasons: [], blockedFanOut: 0,
      nextAction: "Finish the bounded accessibility review, then refresh the accepted evidence.", evidence: "evidence-keyboard-current", consequence: "tier_1",
      polar: { lane: "keyboard-evidence", angleDegrees: 0, receiptAgeMinutes: 1, freshnessRing: "current", blockedFanOut: 0 },
    },
    {
      id: "ash-ci-queue", outcomeId: "release-validation", itemId: "item-release-validation", runId: "run-ash-02", authorityGeneration: 2,
      callsign: "Ash", profile: "hosted-runner", state: "queued", phase: "runner-admission", receiptAgeMinutes: 12,
      receiptLabel: "Hosted queue receipt", candidate: "4fa73b1", artifact: null, queuePosition: "unknown", attentionReasons: [], blockedFanOut: 0,
      nextAction: "Start the validation jobs when the fictional runner assigns capacity.", evidence: "evidence-runner-queued", consequence: "tier_1",
      polar: { lane: "release-validation", angleDegrees: 60, receiptAgeMinutes: 12, freshnessRing: "current", blockedFanOut: 0 },
    },
    {
      id: "lumen-external-wait", outcomeId: "publication-proof", itemId: "item-publication-proof", runId: "run-lumen-05", authorityGeneration: 5,
      callsign: "Lumen", profile: "hosted-runner", state: "waiting_external", phase: "provider-verification", receiptAgeMinutes: 38,
      receiptLabel: "External gate receipt", candidate: "8fdf697", artifact: null, queuePosition: "unknown", attentionReasons: ["external_wait_old", "stale_receipt"], blockedFanOut: 1,
      nextAction: "Refresh the provider receipt before accepting the publication result.", evidence: "evidence-publication-wait", consequence: "tier_2",
      polar: { lane: "publication-proof", angleDegrees: 120, receiptAgeMinutes: 38, freshnessRing: "stale", blockedFanOut: 1 },
    },
    {
      id: "ember-checkpoint", outcomeId: "resume-safety", itemId: "item-resume-safety", runId: "run-ember-07", authorityGeneration: 7,
      callsign: "Ember", profile: "adapter-review", state: "stalled", phase: "checkpoint-review", receiptAgeMinutes: 46,
      receiptLabel: "Missed heartbeat receipt", candidate: "5de73a1", artifact: null, queuePosition: null, attentionReasons: ["lease_expired", "heartbeat_missed", "stalled", "stale_receipt"], blockedFanOut: 2,
      nextAction: "Admit the stored checkpoint, then begin a fresh bounded generation.", evidence: "evidence-checkpoint-stalled", consequence: "tier_2",
      polar: { lane: "resume-safety", angleDegrees: 180, receiptAgeMinutes: 46, freshnessRing: "stale", blockedFanOut: 2 },
    },
    {
      id: "amber-publication", outcomeId: "remote-settlement", itemId: "item-remote-settlement", runId: "run-amber-03", authorityGeneration: 3,
      callsign: "Amber", profile: "provider-reader", state: "blocked", phase: "reconciliation", receiptAgeMinutes: 6,
      receiptLabel: "Ambiguous operation receipt", candidate: null, artifact: "artifact-publication-receipt", queuePosition: null, attentionReasons: ["ambiguous_settlement", "blocked"], blockedFanOut: 0,
      nextAction: "Read the exact remote receipt before replaying the fictional publication.", evidence: "evidence-publication-ambiguous", consequence: "tier_2",
      polar: { lane: "remote-settlement", angleDegrees: 240, receiptAgeMinutes: 6, freshnessRing: "current", blockedFanOut: 0 },
    },
    {
      id: "violet-release-note", outcomeId: "release-wording", itemId: "item-release-wording", runId: "run-violet-02", authorityGeneration: 2,
      callsign: "Violet", profile: "decision-review", state: "blocked", phase: "human-decision", receiptAgeMinutes: 3,
      receiptLabel: "Human decision request", candidate: "3c9a90f", artifact: null, queuePosition: null, attentionReasons: ["human_decision", "blocked"], blockedFanOut: 0,
      nextAction: "Inspect the concise wording, then approve it or return it for revision.", evidence: "evidence-release-decision", consequence: "tier_2",
      polar: { lane: "release-wording", angleDegrees: 300, receiptAgeMinutes: 3, freshnessRing: "current", blockedFanOut: 0 },
    },
    {
      id: "cedar-shared-gate", outcomeId: "provider-admission", itemId: "item-provider-admission", runId: "run-cedar-06", authorityGeneration: 6,
      callsign: "Cedar", profile: "provider-review", state: "blocked", phase: "shared-dependency", receiptAgeMinutes: 8,
      receiptLabel: "Dependency receipt", candidate: "2bb892a", artifact: null, queuePosition: null, attentionReasons: ["blocked", "high_fan_out"], blockedFanOut: 3,
      nextAction: "Clear the shared provider gate for the three fictional downstream attempts.", evidence: "evidence-provider-dependency", consequence: "tier_2",
      polar: { lane: "provider-admission", angleDegrees: 30, receiptAgeMinutes: 8, freshnessRing: "current", blockedFanOut: 3 },
    },
    {
      id: "old-moss-accessibility", outcomeId: "keyboard-evidence", itemId: "item-keyboard-evidence", runId: "run-moss-01", authorityGeneration: 3,
      callsign: "Moss", profile: "review-worker", state: "cancelled", phase: "terminal", receiptAgeMinutes: 91,
      receiptLabel: "Superseded terminal receipt", candidate: "1d8159d", artifact: null, queuePosition: null, attentionReasons: [], blockedFanOut: 0,
      nextAction: "Open the successor accessibility attempt.", evidence: "evidence-keyboard-superseded", consequence: "tier_1",
      polar: { lane: "keyboard-evidence", angleDegrees: 0, receiptAgeMinutes: 91, freshnessRing: "stale", blockedFanOut: 0 },
    },
  ],
  relations: [
    { id: "rel-moss-supersedes", kind: "supersedes", from: "moss-accessibility", to: "old-moss-accessibility", label: "The current accessibility review supersedes the earlier attempt.", evidence: "evidence-keyboard-lineage" },
    { id: "rel-gate-checkpoint", kind: "dependency", from: "cedar-shared-gate", to: "ember-checkpoint", label: "Resume safety consumes the shared provider admission boundary.", evidence: "evidence-gate-checkpoint" },
    { id: "rel-gate-external", kind: "stacked_candidate", from: "cedar-shared-gate", to: "lumen-external-wait", label: "Publication proof waits on the shared provider admission generation.", evidence: "evidence-gate-publication" },
    { id: "rel-gate-decision", kind: "contract_overlap", from: "cedar-shared-gate", to: "violet-release-note", label: "Both attempts consume the same bounded review contract.", evidence: "evidence-gate-decision" },
    { id: "rel-queue-external", kind: "shared_external_gate", from: "ash-ci-queue", to: "lumen-external-wait", label: "Both attempts wait on the same fictional hosted runner gate.", evidence: "evidence-shared-runner" },
    { id: "rel-checkpoint-publication", kind: "file_overlap", from: "ember-checkpoint", to: "amber-publication", label: "Checkpoint recovery and settlement share one recovery record.", evidence: "evidence-recovery-overlap" },
    { id: "rel-moss-handoff", kind: "handoff", from: "old-moss-accessibility", to: "moss-accessibility", label: "The current review continues the earlier exact handoff.", evidence: "evidence-keyboard-handoff" },
  ],
  attention: [
    { id: "attention-human-decision", attemptId: "violet-release-note", reason: "human_decision", label: "One release-note decision is ready.", nextAction: "Inspect the concise wording and record the decision.", evidence: "evidence-release-decision" },
    { id: "attention-ambiguous", attemptId: "amber-publication", reason: "ambiguous_settlement", label: "The fictional publication outcome remains ambiguous.", nextAction: "Reconcile the exact remote receipt before replay.", evidence: "evidence-publication-ambiguous" },
    { id: "attention-lease", attemptId: "ember-checkpoint", reason: "lease_expired", label: "The checkpoint attempt lease expired.", nextAction: "Review the handoff and begin a fresh generation.", evidence: "evidence-checkpoint-stalled" },
    { id: "attention-fanout", attemptId: "cedar-shared-gate", reason: "high_fan_out", label: "One dependency blocks three downstream attempts.", nextAction: "Clear the shared provider admission gate.", evidence: "evidence-provider-dependency" },
    { id: "attention-external", attemptId: "lumen-external-wait", reason: "external_wait_old", label: "The hosted wait crossed the attention threshold.", nextAction: "Refresh the exact provider receipt.", evidence: "evidence-publication-wait" },
  ],
  events: [
    { id: "event-moss-admitted", attemptId: "moss-accessibility", at: "2026-01-15T09:50:00.000Z", kind: "admitted", label: "The current accessibility review was admitted.", evidence: "evidence-keyboard-admission" },
    { id: "event-moss-candidate", attemptId: "moss-accessibility", at: "2026-01-15T10:29:00.000Z", kind: "candidate", label: "The current review candidate was published.", evidence: "evidence-keyboard-current" },
    { id: "event-queue-wait", attemptId: "ash-ci-queue", at: "2026-01-15T10:18:00.000Z", kind: "wait", label: "The validation jobs entered the fictional hosted queue.", evidence: "evidence-runner-queued" },
    { id: "event-checkpoint-stalled", attemptId: "ember-checkpoint", at: "2026-01-15T09:44:00.000Z", kind: "stalled", label: "Heartbeat and lease evidence expired.", evidence: "evidence-checkpoint-stalled" },
    { id: "event-publication-reconcile", attemptId: "amber-publication", at: "2026-01-15T10:24:00.000Z", kind: "reconciliation", label: "Replay was held for remote reconciliation.", evidence: "evidence-publication-ambiguous" },
    { id: "event-release-decision", attemptId: "violet-release-note", at: "2026-01-15T10:27:00.000Z", kind: "decision", label: "The release-note decision was requested.", evidence: "evidence-release-decision" },
    { id: "event-old-moss-superseded", attemptId: "old-moss-accessibility", at: "2026-01-15T09:05:00.000Z", kind: "superseded", label: "The earlier accessibility attempt was superseded.", evidence: "evidence-keyboard-lineage" },
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
  { id: "active-attempts", prompt: "Identify every current attempt and its exact candidate or artifact.", start: "list", success: "moss-accessibility,ash-ci-queue,lumen-external-wait,ember-checkpoint,amber-publication,violet-release-note,cedar-shared-gate" },
  { id: "external-wait", prompt: "Distinguish source work from the attempt waiting on a hosted provider.", start: "list", success: "lumen-external-wait" },
  { id: "human-decision", prompt: "Find the only explicit human decision and its safe next action.", start: "attention", success: "violet-release-note" },
  { id: "fan-out", prompt: "Find the blocker with the highest declared downstream fan-out.", start: "polar", success: "cedar-shared-gate" },
  { id: "stale-receipt", prompt: "Explain why the checkpoint attempt is stale without using animation or chat presence.", start: "attention", success: "ember-checkpoint" },
  { id: "reconciliation", prompt: "Locate the ambiguous publication and the action that avoids blind replay.", start: "attention", success: "amber-publication" },
  { id: "supersession", prompt: "Trace the current accessibility attempt back to the superseded run.", start: "lanes", success: "rel-moss-supersedes" },
  { id: "shared-gate", prompt: "Find two attempts waiting on the same external runner gate.", start: "lanes", success: "rel-queue-external" },
  { id: "receipt-history", prompt: "Open the event that published the current accessibility candidate.", start: "timeline", success: "event-moss-candidate" },
  { id: "same-callsign", prompt: "Show why two Moss rows represent separate attempts.", start: "list", success: "moss-accessibility,old-moss-accessibility" },
];

export const workPulseFixture = parseWorkPulseFixture(sourceFixture);
export const workPulseFixtureTasks = parseWorkPulseFixtureTasks(sourceTasks);

export function parseWorkPulseFixture(value) {
  exactRecord(value, ["attempts", "attention", "events", "observedAt", "relations", "views"], "Work Pulse fixture");
  const observedAt = timestamp(value.observedAt, "Fixture observation");
  const attempts = parseList(value.attempts, 1, 40, parseAttempt, "Work Pulse attempts");
  unique(attempts.map((attempt) => attempt.id), "attempt ids");
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const relations = parseList(value.relations, 0, 100, parseRelation, "Work Pulse relations");
  const attention = parseList(value.attention, 0, 100, parseAttention, "Work Pulse attention");
  const events = parseList(value.events, 0, 200, parseEvent, "Work Pulse events");
  const views = parseList(value.views, 5, 5, parseView, "Work Pulse views");
  unique(relations.map((relation) => relation.id), "relation ids");
  unique(attention.map((entry) => entry.id), "attention ids");
  unique(events.map((event) => event.id), "event ids");
  unique(views.map((view) => view.id), "view ids");

  const relationIdentities = new Set();
  for (const relation of relations) {
    if (!attemptsById.has(relation.from) || !attemptsById.has(relation.to)) {
      throw new TypeError("Work Pulse relation references an unknown attempt");
    }
    if (relation.from === relation.to) throw new TypeError("Work Pulse relation cannot reference itself");
    const semanticIdentity = `${relation.kind}:${relation.from}:${relation.to}`;
    if (relationIdentities.has(semanticIdentity)) {
      throw new TypeError("Work Pulse relation semantic identities must be unique");
    }
    relationIdentities.add(semanticIdentity);
  }
  for (const entry of attention) {
    const attempt = attemptsById.get(entry.attemptId);
    if (!attempt) throw new TypeError("Work Pulse attention references an unknown attempt");
    if (!attempt.attentionReasons.includes(entry.reason)) {
      throw new TypeError("Work Pulse attention reason must be declared by its attempt");
    }
  }
  const observedAtMs = Date.parse(observedAt);
  for (const event of events) {
    if (!attemptsById.has(event.attemptId)) throw new TypeError("Work Pulse event references an unknown attempt");
    if (Date.parse(event.at) > observedAtMs) {
      throw new TypeError("Work Pulse event cannot follow fixture observation time");
    }
  }
  if (views.length !== viewIds.size || views.some((view) => !viewIds.has(view.id))) {
    throw new TypeError("Work Pulse views must cover the complete vocabulary");
  }
  return deepFreeze({ observedAt, attempts, relations, attention, events, views });
}

export function parseWorkPulseFixtureTasks(value) {
  const tasks = parseList(value, 1, 30, (entry, index) => {
    exactRecord(entry, taskKeys, `Work Pulse task ${index + 1}`);
    return Object.freeze({
      id: slug(entry.id, "Task id"),
      prompt: text(entry.prompt, 220, "Task prompt"),
      start: closed(entry.start, viewIds, "Task start"),
      success: taskSuccess(entry.success),
    });
  }, "Work Pulse tasks");
  unique(tasks.map((task) => task.id), "task ids");
  return Object.freeze(tasks);
}

function parseAttempt(value, index) {
  exactRecord(value, attemptKeys, `Work Pulse attempt ${index + 1}`);
  const queuePosition = value.queuePosition === null || value.queuePosition === "unknown"
    ? value.queuePosition
    : integer(value.queuePosition, 1, 1000000, "Queue position");
  if (value.state !== "queued" && value.state !== "waiting_external" && queuePosition !== null) {
    throw new TypeError("Only queued or external-wait attempts may carry queue position");
  }
  const reasons = parseList(value.attentionReasons, 0, 12, (reason) => closed(reason, attentionReasons, "Attention reason"), "Attention reasons");
  unique(reasons, "attention reasons");
  const polar = parsePolar(value.polar);
  if (polar.receiptAgeMinutes !== value.receiptAgeMinutes || polar.blockedFanOut !== value.blockedFanOut || polar.lane !== value.outcomeId) {
    throw new TypeError("Polar identity must match the attempt");
  }
  return deepFreeze({
    id: slug(value.id, "Attempt id"),
    outcomeId: slug(value.outcomeId, "Outcome id"),
    itemId: slug(value.itemId, "Item id"),
    runId: slug(value.runId, "Run id"),
    authorityGeneration: integer(value.authorityGeneration, 1, Number.MAX_SAFE_INTEGER, "Authority generation"),
    callsign: text(value.callsign, 60, "Callsign"),
    profile: slug(value.profile, "Profile"),
    state: closed(value.state, attemptStates, "Attempt state"),
    phase: slug(value.phase, "Attempt phase"),
    receiptAgeMinutes: integer(value.receiptAgeMinutes, 0, 1000000, "Receipt age"),
    receiptLabel: text(value.receiptLabel, 120, "Receipt label"),
    candidate: nullableRevision(value.candidate, "Candidate"),
    artifact: nullableIdentifier(value.artifact, "Artifact"),
    queuePosition,
    attentionReasons: reasons,
    blockedFanOut: integer(value.blockedFanOut, 0, 1000, "Blocked fan-out"),
    nextAction: text(value.nextAction, 320, "Next action"),
    evidence: identifier(value.evidence, "Evidence"),
    consequence: closed(value.consequence, consequenceClasses, "Consequence"),
    polar,
  });
}

function parsePolar(value) {
  exactRecord(value, polarKeys, "Work Pulse polar coordinate");
  return Object.freeze({
    lane: slug(value.lane, "Polar lane"),
    angleDegrees: integer(value.angleDegrees, 0, 359, "Polar angle"),
    receiptAgeMinutes: integer(value.receiptAgeMinutes, 0, 1000000, "Polar receipt age"),
    freshnessRing: closed(value.freshnessRing, new Set(["current", "stale"]), "Freshness ring"),
    blockedFanOut: integer(value.blockedFanOut, 0, 1000, "Polar blocked fan-out"),
  });
}

function parseRelation(value, index) {
  exactRecord(value, relationKeys, `Work Pulse relation ${index + 1}`);
  return Object.freeze({
    id: slug(value.id, "Relation id"),
    kind: closed(value.kind, relationKinds, "Relation kind"),
    from: slug(value.from, "Relation source"),
    to: slug(value.to, "Relation target"),
    label: text(value.label, 240, "Relation label"),
    evidence: identifier(value.evidence, "Relation evidence"),
  });
}

function parseAttention(value, index) {
  exactRecord(value, attentionKeys, `Work Pulse attention ${index + 1}`);
  return Object.freeze({
    id: slug(value.id, "Attention id"),
    attemptId: slug(value.attemptId, "Attention attempt"),
    reason: closed(value.reason, attentionReasons, "Attention reason"),
    label: text(value.label, 240, "Attention label"),
    nextAction: text(value.nextAction, 320, "Attention next action"),
    evidence: identifier(value.evidence, "Attention evidence"),
  });
}

function parseEvent(value, index) {
  exactRecord(value, eventKeys, `Work Pulse event ${index + 1}`);
  return Object.freeze({
    id: slug(value.id, "Event id"),
    attemptId: slug(value.attemptId, "Event attempt"),
    at: timestamp(value.at, "Event time"),
    kind: closed(value.kind, eventKinds, "Event kind"),
    label: text(value.label, 240, "Event label"),
    evidence: identifier(value.evidence, "Event evidence"),
  });
}

function parseView(value, index) {
  exactRecord(value, viewKeys, `Work Pulse view ${index + 1}`);
  return Object.freeze({
    id: closed(value.id, viewIds, "View id"),
    label: text(value.label, 80, "View label"),
    purpose: text(value.purpose, 240, "View purpose"),
  });
}

function parseList(value, minimum, maximum, parser, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a bounded default array`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    throw new TypeError(`${label} length must be an own data property`);
  }
  const length = lengthDescriptor.value;
  if (length < minimum || length > maximum) throw new TypeError(`${label} length is out of range`);
  const expectedKeys = new Set(["length"]);
  for (let index = 0; index < length; index += 1) expectedKeys.add(String(index));
  if (Object.keys(descriptors).some((key) => !expectedKeys.has(key)) || Object.keys(descriptors).length !== expectedKeys.size) {
    throw new TypeError(`${label} fields are invalid`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(`${label} entries must be dense enumerable data properties`);
    }
    result.push(parser(descriptor.value, index));
  }
  return Object.freeze(result);
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${label} fields are invalid`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = [...keys].sort();
  const actual = Object.keys(descriptors).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
  }
}

function taskSuccess(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || unsafeTextPattern.test(value)) {
    throw new TypeError("Task success must contain exact target identities");
  }
  const targets = value.split(",");
  if (targets.some((target) => !idPattern.test(target)) || new Set(targets).size !== targets.length) {
    throw new TypeError("Task success must contain unique lowercase target identities");
  }
  const allowed = new Set([
    ...workPulseFixture.attempts.map((attempt) => attempt.id),
    ...workPulseFixture.relations.map((relation) => relation.id),
    ...workPulseFixture.events.map((event) => event.id),
  ]);
  if (targets.some((target) => !allowed.has(target))) {
    throw new TypeError("Task success references an unknown fixture target");
  }
  return targets.join(",");
}

function closed(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) throw new TypeError(`${label} is unsupported`);
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${label}`);
}
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
function nullableRevision(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{7,40}$/u.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}
function nullableIdentifier(value, label) {
  return value === null ? null : identifier(value, label);
}
function identifier(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || unsafeTextPattern.test(value) || !identifierPattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
function slug(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100 || unsafeTextPattern.test(value) || !idPattern.test(value)) {
    throw new TypeError(`${label} must be an exact lowercase slug`);
  }
  return value;
}
function timestamp(value, label) {
  if (typeof value !== "string" || !timestampPattern.test(value)) throw new TypeError(`${label} must be canonical UTC`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be canonical UTC`);
  try {
    if (new Date(milliseconds).toISOString() !== value) throw new TypeError(`${label} must be canonical UTC`);
  } catch {
    throw new TypeError(`${label} must be canonical UTC`);
  }
  return value;
}
function text(value, maximum, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || unsafeTextPattern.test(normalized)) {
    throw new TypeError(`${label} must contain 1-${maximum} safe characters`);
  }
  return normalized;
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
