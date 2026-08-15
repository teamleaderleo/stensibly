import type { ControlRoomResumeInspectionAssemblyV1 } from "./control-room-resume-inspection.js";

export function renderControlRoomResumeInspection(
  inspection: ControlRoomResumeInspectionAssemblyV1,
): string {
  const checks = inspection.checks.map((check) => `
        <article class="check check-${escapeHtml(check.state)}">
          <div class="check-head">
            <strong>${escapeHtml(check.label)}</strong>
            <span>${escapeHtml(check.state)}</span>
          </div>
          <p>${escapeHtml(check.detail)}</p>
        </article>`).join("");
  const checkpoint = inspection.checkpoint
    ? inspection.checkpoint.externalId
      ?? inspection.checkpoint.digest
      ?? inspection.checkpoint.uri
      ?? "admitted reference"
    : "none admitted";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>Stensibly · Resume inspection</title>
    <style>
      :root{color-scheme:dark;font-family:system-ui,sans-serif}
      body{margin:0;background:#0d0d0f;color:#f2f2f5}main{max-width:900px;margin:auto;padding:1.25rem}a{color:inherit}
      .top,.check-head{display:flex;justify-content:space-between;gap:1rem}h1,p{margin:0}.guard,.check p,.footer{color:#aaa}
      .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem;margin:1rem 0}.metric,.check{border:1px solid #34343c;border-radius:.6rem;padding:.75rem}
      .metric small,.check-head span{display:block;text-transform:uppercase;font-size:.7rem;color:#aaa}.metric strong{display:block;margin-top:.25rem;overflow-wrap:anywhere}
      .checks{display:grid;gap:.5rem}.check{border-left:3px solid #9ac7ff}.check-pass{border-left-color:#8ce0b0}.check-blocked{border-left-color:#ff9a76}.check p{margin-top:.3rem;line-height:1.4}.footer{margin-top:1rem}
      @media(max-width:720px){.summary{grid-template-columns:repeat(2,1fr)}}
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
      <section class="summary" aria-label="Resume inspection summary">
        ${metric("Decision", inspection.decision)}
        ${metric("Run status", inspection.status)}
        ${metric("Project", inspection.project)}
        ${metric("Checkpoint", checkpoint)}
      </section>
      <section class="checks" aria-label="Resume evidence checks">${checks}</section>
      <p class="footer">This page only reads durable evidence. Eligibility remains unknown until the authoritative RunnerResumeInspectionV1 compiler receives a complete server-side candidate and current runtime capability admission.</p>
    </main>
  </body>
</html>`;
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
