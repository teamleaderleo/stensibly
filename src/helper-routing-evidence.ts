import {
  admitGlaedaWorkstationCheckV1,
  admitGlaedaWorkstationReceiptV1,
  assertGlaedaWorkstationCheckMatchesCommandV1,
  assertGlaedaWorkstationReceiptMatchesCommandV1,
  fingerprintGlaedaWorkstationCommandV1,
  normalizeGlaedaWorkstationCommandV1,
} from "./glaeda-workstation-contracts.js";

/** Read-only research projection. Canonical execution receipts prove neither
 * provider success nor acceptance of the surrounding source-development task.
 */
export function projectHelperRoutingEvidenceV1(value: unknown) {
  const results = Array.isArray(value) ? value : [value];
  if (results.length === 0 || results.length > 128) throw new Error("Expected 1 to 128 adapter results");
  const seen = new Set<string>();
  const tasks = results.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid adapter result");
    const result = raw as Record<string, unknown>;
    if (result.version !== 1 || result.kind !== "glaeda_workstation_adapter_result") {
      throw new Error("Expected Glaeda workstation adapter result v1");
    }
    const command = normalizeGlaedaWorkstationCommandV1(result.command);
    const check = admitGlaedaWorkstationCheckV1(result.check);
    assertGlaedaWorkstationCheckMatchesCommandV1(command, check);
    const fingerprint = fingerprintGlaedaWorkstationCommandV1(command);
    if (result.commandFingerprint !== fingerprint) throw new Error("Adapter command fingerprint changed");
    const taskRef = `stensibly:${encodeURIComponent(command.project)}/${encodeURIComponent(command.itemId)}/${encodeURIComponent(command.source.repository)}/${command.source.commitOid}/${command.source.treeOid}`;
    if (seen.has(taskRef)) throw new Error("Duplicate parent work/source observation; reconcile its commands before task-level analysis");
    seen.add(taskRef);
    const receipt = result.receipt === null ? null : admitGlaedaWorkstationReceiptV1(result.receipt);
    if (receipt) assertGlaedaWorkstationReceiptMatchesCommandV1(command, check, receipt);
    const terminal = receipt?.terminalClass ?? null;
    const verification = command.profile.class === "verify_focused" || command.profile.class === "verify_required";
    const succeeded = terminal === "succeeded" ? true : terminal === "failed" ? false : null;
    return {
      task_ref: taskRef,
      evidence_refs: [
        `stensibly-command:${fingerprint}`,
        `stensibly-run:${encodeURIComponent(command.project)}/${encodeURIComponent(command.runId)}`,
        `https://github.com/${command.source.repository}/commit/${command.source.commitOid}`,
        `git-tree:${command.source.treeOid}`,
        ...(receipt ? [`glaeda-result:${receipt.resultSha256}`] : []),
      ],
      route: null,
      classification_timing: null,
      classification: { oracle_strength: null, semantic_ambiguity: null, coupling: null, failure_cost: null },
      outcomes: {
        provider_success: null,
        process_completed: null,
        verified: verification ? succeeded : null,
        accepted: null,
      },
      metrics: { retries: null, repair_minutes: null, wall_seconds: null, task_tokens: null },
      provider_usage: [],
      limitations: [
        `OBSERVED: exact ${command.profile.class} command; physical terminal class ${terminal ?? "unknown"}.`,
        "UNKNOWN: source-work acceptance, provider outcome, route, classification and total task accounting are not supplied by this execution receipt.",
        "UNKNOWN: refused, timed-out, cleanup-incomplete or absent physical receipts do not establish a completed process or a verification assertion result.",
        "DERIVED: this is incomplete evidence about one parent work/source identity; command-process success does not establish completion of that parent work.",
        "DERIVED: verified describes only the named check in this receipt, not all checks or acceptance required by the parent work.",
        ...(!receipt ? ["UNKNOWN: no physical receipt is present; a settlement-only replay is not reconstructed as fresh execution evidence."] : []),
      ],
    };
  });
  return { schema: "cultist-helper-routing-evidence/v1", tasks };
}
