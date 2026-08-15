import type {
  ControlRoomResumeEligibilityExplanationV1,
  ControlRoomResumeInspectionAssemblyV1,
} from "./control-room-resume-inspection.js";

export function renderControlRoomResumeInspection(
  inspection: ControlRoomResumeInspectionAssemblyV1,
): string {
  const eligibility = inspection.eligibility;
  const authoritative = eligibility === null
    ? `<section class="decision decision-${escapeHtml(inspection.decision)}">
        <strong>${escapeHtml(inspection.decision)}</strong>
        <p>Current authoritative eligibility evidence is incomplete. No resume authority is granted.</p>
      </section>`
    : renderEligibility(eligibility);
  const sourceChecks = inspection.checks.map((check) => `
        <article class="check check-${escapeHtml(check.state)}">
          <div class="check-head">
            <strong>${escapeHtml(check.label)}</strong>
            <span>${escapeHtml(check.state)}</span>
          </div>
          <p>${escapeHtml(check.detail)}</p>
        </article>`).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>Stensibly · Resume inspection</title>
    <style>
      :root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;background:#0d0d0f;color:#f2f2f5}main{max-width:960px;margin:auto;padding:1.25rem}a{color:inherit}h1,h2,h3,p{margin:0}.top,.check-head,.reason-head{display:flex;justify-content:space-between;gap:1rem}.guard,.muted,.check p,.reason p,.footer{color:#aaa}.decision{margin:1rem 0;border:1px solid #41414a;border-left:4px solid #9ac7ff;border-radius:.65rem;padding:1rem}.decision strong{display:block;font-size:1.45rem;text-transform:uppercase}.decision-eligible{border-left-color:#8ce0b0}.decision-blocked{border-left-color:#ff9a76}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem;margin:1rem 0}.metric,.check,.reason,.sources{border:1px solid #34343c;border-radius:.6rem;padding:.75rem}.metric small,.check-head span,.reason-head span{display:block;text-transform:uppercase;font-size:.7rem;color:#aaa}.metric strong{display:block;margin-top:.25rem;overflow-wrap:anywhere}.sections,.checks{display:grid;gap:.75rem}.section{display:grid;gap:.5rem}.reason-pass,.check-pass{border-left:3px solid #8ce0b0}.reason-block,.check-blocked{border-left:3px solid #ff9a76}.reason-unknown,.check-unknown{border-left:3px solid #9ac7ff}.reason p,.check p{margin-top:.3rem;line-height:1.4}.exact{margin-top:.35rem;font-size:.82rem;overflow-wrap:anywhere}.sources{margin:1rem 0}.sources dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem .8rem;margin:.6rem 0 0}.sources dt{color:#aaa}.sources dd{margin:0;overflow-wrap:anywhere}.checks{margin-top:.75rem}.footer{margin-top:1rem}@media(max-width:720px){.summary{grid-template-columns:repeat(2,1fr)}.sources dl{grid-template-columns:1fr}.top{display:block}.top a{display:inline-block;margin-top:.5rem}}
    </style>
  </head>
  <body>
    <main>
      <header class="top">
        <div>
          <h1>Resume inspection · ${escapeHtml(inspection.runId)}</h1>
          <p class="guard">Read-only evidence · authorizesMutation=false · authorizesResume=false</p>
        </div>
        <a href="/">← Control Room</a>
      </header>
      ${authoritative}
      <section class="summary" aria-label="Resume inspection summary">
        ${metric("Decision", inspection.decision)}
        ${metric("Run status", inspection.status)}
        ${metric("Project", inspection.project)}
        ${metric("Continuation", inspection.continuationRef ?? "unknown")}
      </section>
      ${eligibility === null ? "" : renderSources(eligibility)}
      <h2>Live source assembly</h2>
      <section class="checks" aria-label="Live resume evidence sources">${sourceChecks}</section>
      <p class="footer">This surface explains current eligibility only. It creates no resume, fork, or cancellation command and performs no provider or runner effect.</p>
    </main>
  </body>
</html>`;
}

function renderEligibility(eligibility: ControlRoomResumeEligibilityExplanationV1): string {
  const sections = eligibility.sections.map((section) => `
      <section class="section" aria-label="${escapeHtml(section.title)}">
        <h3>${escapeHtml(section.title)}</h3>
        ${section.reasons.map((reason) => `
        <article class="reason reason-${escapeHtml(reason.state)}">
          <div class="reason-head"><strong>${escapeHtml(reason.summary)}</strong><span>${escapeHtml(reason.state)}</span></div>
          <p class="exact"><code>${escapeHtml(reason.code)}</code></p>
          <p class="exact">expected: <code>${escapeHtml(reason.expected ?? "unknown")}</code></p>
          <p class="exact">observed: <code>${escapeHtml(reason.observed ?? "unknown")}</code></p>
        </article>`).join("")}
      </section>`).join("");
  return `<section class="decision decision-${escapeHtml(eligibility.decision)}">
        <strong>${escapeHtml(eligibility.decision)}</strong>
        <p>${escapeHtml(eligibility.headline)}</p>
        <p class="muted">Inspection guidance: ${escapeHtml(eligibility.supportedActions.join(", "))}. This is explanatory text, not an execution control.</p>
      </section>
      <section class="sections" aria-label="Authoritative resume eligibility reasons">${sections}</section>`;
}

function renderSources(eligibility: ControlRoomResumeEligibilityExplanationV1): string {
  const checkpoint = eligibility.checkpoint;
  const capability = eligibility.currentCapability;
  const prior = eligibility.priorCommand;
  return `<section class="sources" aria-label="Exact resume evidence identities">
        <h2>Exact evidence identities</h2>
        <dl>
          <dt>Receipt fingerprint</dt><dd><code>${escapeHtml(eligibility.receiptFingerprint)}</code></dd>
          <dt>Evaluator</dt><dd><code>${escapeHtml(eligibility.evaluatorVersion)}</code> at <code>${escapeHtml(eligibility.observedAt)}</code></dd>
          <dt>Run</dt><dd><code>${escapeHtml(`${eligibility.run.id} / run ${eligibility.run.generation} / lease ${eligibility.run.leaseGeneration}`)}</code></dd>
          <dt>Adapter</dt><dd><code>${escapeHtml(`${eligibility.adapter.id}@${eligibility.adapter.version} / ${eligibility.adapter.profileId}@${eligibility.adapter.profileVersion}`)}</code></dd>
          <dt>Checkpoint</dt><dd><code>${escapeHtml(checkpoint ? `${checkpoint.externalId ?? "unknown"} / ${checkpoint.digest ?? "unknown"} / generation ${checkpoint.generation ?? "unknown"}` : "unknown")}</code></dd>
          <dt>Capability binding</dt><dd><code>${escapeHtml(capability?.commandFingerprint ?? "unknown")}</code></dd>
          <dt>Capability snapshot</dt><dd><code>${escapeHtml(capability?.snapshotFingerprint ?? "unknown")}</code></dd>
          <dt>Required capabilities</dt><dd><code>${escapeHtml(capability?.requiredFingerprint ?? "unknown")}</code></dd>
          <dt>Effective surface</dt><dd><code>${escapeHtml(capability?.surfaceFingerprint ?? "unknown")}</code></dd>
          <dt>Prior command</dt><dd><code>${escapeHtml(prior ? `${prior.commandId} / ${prior.commandFingerprint}` : "unknown")}</code></dd>
          <dt>Prior outcome</dt><dd><code>${escapeHtml(prior?.outcomeFingerprint ?? "unknown")}</code></dd>
        </dl>
      </section>`;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
