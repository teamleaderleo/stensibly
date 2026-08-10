import {
  createRepositoryAttachmentDraft,
  localDraftSourceRevision,
  readAcceptedProjectAttachment,
  readProjectAttachmentAcceptance,
  readProjectAttachmentReview,
  reviewSource,
  reviewSourceRevision,
} from './project-attachment-review.js';
import { readProjectSetupStatus, setupStepLabel } from './project-setup-status.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const RESET_CONNECTION_STATES = new Set(['connecting', 'editing', 'disconnected', 'connection failed']);

export function installProjectSetupStatusCard() {
  const sessionContext = document.querySelector('#session-context-panel');
  const dashboard = document.querySelector('#dashboard');
  const projectFilter = document.querySelector('#project-filter');
  const connectionState = document.querySelector('#connection-state');
  if (!sessionContext || !dashboard || !(projectFilter instanceof HTMLSelectElement)) return null;
  if (document.querySelector('#project-setup-status-panel')) return null;

  installStylesheet();
  sessionContext.insertAdjacentHTML('beforebegin', panelMarkup());

  const panel = document.querySelector('#project-setup-status-panel');
  const projectSelect = document.querySelector('#project-setup-status-project');
  const refreshButton = document.querySelector('#project-setup-status-refresh');
  const status = document.querySelector('#project-setup-status-state');
  const error = document.querySelector('#project-setup-status-error');
  const body = document.querySelector('#project-setup-status-body');
  if (
    !(panel instanceof HTMLDetailsElement)
    || !(projectSelect instanceof HTMLSelectElement)
    || !(refreshButton instanceof HTMLButtonElement)
    || !status
    || !error
    || !body
  ) {
    panel?.remove();
    return null;
  }

  let requestGeneration = 0;
  let projectFingerprint = '';
  syncProjects();

  const onToggle = () => {
    if (panel.open) void refresh();
    else invalidate();
  };
  const onRefresh = () => void refresh();
  const onProjectChange = () => {
    invalidate();
    if (panel.open) void refresh();
  };
  const onFilterChange = () => {
    syncProjects();
    if (panel.open) void refresh();
  };
  panel.addEventListener('toggle', onToggle);
  refreshButton.addEventListener('click', onRefresh);
  projectSelect.addEventListener('change', onProjectChange);
  projectFilter.addEventListener('change', onFilterChange);

  const projectObserver = new MutationObserver(syncProjects);
  projectObserver.observe(projectFilter, { childList: true, subtree: true });
  const dashboardObserver = new MutationObserver(() => {
    syncProjects();
    if (dashboard.hidden) reset();
  });
  dashboardObserver.observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });
  const connectionObserver = connectionState
    ? new MutationObserver(() => {
        const label = connectionState.textContent?.trim().toLowerCase() || '';
        if (RESET_CONNECTION_STATES.has(label)) reset();
      })
    : null;
  connectionObserver?.observe(connectionState, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  async function refresh() {
    const project = projectSelect.value;
    if (!panel.open || !project) return;
    const connection = readConnection();
    if (!connection.endpoint || !connection.token) {
      showFailure('Connect this studio before reading project setup.');
      return;
    }

    const requestId = ++requestGeneration;
    clearFailure();
    refreshButton.disabled = true;
    status.textContent = 'reading';
    body.replaceChildren(messageBlock('Reading server-owned setup status…', 'project-setup-status-loading'));

    let response;
    try {
      response = await window.fetch(
        `${connection.endpoint}/api/v1/projects/${encodeURIComponent(project)}/setup-status`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${connection.token}`,
          },
          cache: 'no-store',
        },
      );
    } catch {
      if (!current(requestId, project, connection)) return;
      showFailure('Setup status could not reach the API. Check the connection and retry.');
      return;
    }

    const payload = await responseJson(response);
    if (!current(requestId, project, connection)) return;
    if (!response.ok) {
      showFailure(httpFailure(response.status));
      return;
    }

    let setupStatus;
    try {
      setupStatus = readProjectSetupStatus(payload, project);
    } catch {
      showFailure('The API returned an incompatible setup-status response.');
      return;
    }

    refreshButton.disabled = false;
    status.textContent = stateLabel(setupStatus.state);
    renderSetupStatus(body, setupStatus);
    wireAttachmentOwnerAction(setupStatus, project, connection, requestId);
  }

  function wireAttachmentOwnerAction(setup, project, connection, requestId) {
    const recovery = setup.repositoryRecovery;
    const proposal = setup.repositorySetupObservation;
    if (recovery?.state !== 'attachment_required' || !proposal) return;
    const action = body.querySelector('[data-project-attachment-owner-action]');
    const source = action?.querySelector('[data-project-attachment-source]');
    const revision = action?.querySelector('[data-project-attachment-revision]');
    const generateButton = action?.querySelector('[data-project-attachment-generate]');
    const reviewButton = action?.querySelector('[data-project-attachment-review]');
    const result = action?.querySelector('[data-project-attachment-result]');
    if (
      !(action instanceof HTMLElement)
      || !(source instanceof HTMLTextAreaElement)
      || !(revision instanceof HTMLInputElement)
      || !(generateButton instanceof HTMLButtonElement)
      || !(reviewButton instanceof HTMLButtonElement)
      || !(result instanceof HTMLElement)
    ) return;

    let activeReview = null;
    let reviewedSource = '';
    let reviewedRevision = '';

    const clearReview = (message = '') => {
      activeReview = null;
      reviewedSource = '';
      reviewedRevision = '';
      result.replaceChildren(...(message
        ? [messageBlock(message, 'project-setup-status-note')]
        : []));
    };
    const invalidateReview = () => {
      if (activeReview) clearReview('Source or revision changed. Review again before acceptance.');
    };
    source.addEventListener('input', invalidateReview);
    revision.addEventListener('input', invalidateReview);

    generateButton.addEventListener('click', async () => {
      clearReview();
      generateButton.disabled = true;
      reviewButton.disabled = true;
      result.replaceChildren(messageBlock('Generating a local draft…', 'project-setup-status-loading'));
      try {
        const draft = createRepositoryAttachmentDraft({ project, proposal, recovery });
        const draftRevision = await localDraftSourceRevision(draft);
        if (!current(requestId, project, connection)) return;
        source.value = draft;
        revision.value = draftRevision;
        result.replaceChildren(messageBlock(
          'Local draft generated from the saved repository plan. Read the exact source before previewing it.',
          'project-setup-status-note',
        ));
      } catch {
        if (!current(requestId, project, connection)) return;
        result.replaceChildren(messageBlock(
          'A safe local STENSIBLY.md draft could not be generated from the current setup plan.',
          'project-setup-status-error',
        ));
      } finally {
        if (current(requestId, project, connection)) {
          generateButton.disabled = false;
          reviewButton.disabled = false;
        }
      }
    });

    reviewButton.addEventListener('click', async () => {
      clearReview();
      let sourceText;
      let sourceRevision;
      try {
        sourceText = reviewSource(source.value);
        sourceRevision = reviewSourceRevision(revision.value);
      } catch (reviewError) {
        result.replaceChildren(messageBlock(
          reviewError instanceof Error ? reviewError.message : 'The reviewed source is invalid.',
          'project-setup-status-error',
        ));
        return;
      }

      generateButton.disabled = true;
      reviewButton.disabled = true;
      result.replaceChildren(messageBlock('Compiling the server-owned attachment preview…', 'project-setup-status-loading'));
      let response;
      try {
        response = await window.fetch(
          `${connection.endpoint}/api/v1/projects/${encodeURIComponent(project)}/attachment/review`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${connection.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ source: sourceText, sourceRevision }),
          },
        );
      } catch {
        if (!current(requestId, project, connection)) return;
        result.replaceChildren(messageBlock(
          'Attachment review could not reach the API. Check the connection and retry.',
          'project-setup-status-error',
        ));
        generateButton.disabled = false;
        reviewButton.disabled = false;
        return;
      }

      const payload = await responseJson(response);
      if (!current(requestId, project, connection)) return;
      generateButton.disabled = false;
      reviewButton.disabled = false;
      if (!response.ok) {
        result.replaceChildren(messageBlock(
          attachmentReviewFailure(response.status),
          'project-setup-status-error',
        ));
        return;
      }

      let review;
      try {
        review = readProjectAttachmentReview(payload, {
          project,
          proposalId: proposal.id,
          proposalSemanticFingerprint: proposal.semanticFingerprint,
          repositoryFullName: proposal.repositoryFullName,
          defaultBranch: proposal.defaultBranch,
          sourceRevision,
        });
      } catch {
        result.replaceChildren(messageBlock(
          'The API returned an attachment preview that does not match the current owner action.',
          'project-setup-status-error',
        ));
        return;
      }

      activeReview = review;
      reviewedSource = sourceText;
      reviewedRevision = sourceRevision;
      renderAttachmentReviewDecision(result, review, {
        cancel() {
          clearReview('Review cancelled. No attachment action was sent.');
        },
        async accept(acceptAuthorityWidening) {
          if (
            activeReview !== review
            || source.value !== reviewedSource
            || revision.value !== reviewedRevision
          ) {
            clearReview('The reviewed source became stale. Review again before acceptance.');
            return;
          }
          await acceptReviewedAttachment(
            review,
            acceptAuthorityWidening,
            project,
            connection,
            requestId,
            result,
          );
        },
      });
    });
  }

  async function acceptReviewedAttachment(
    review,
    acceptAuthorityWidening,
    project,
    connection,
    requestId,
    result,
  ) {
    result.replaceChildren(messageBlock('Accepting the reviewed attachment…', 'project-setup-status-loading'));
    let response;
    try {
      response = await window.fetch(
        `${connection.endpoint}/api/v1/projects/${encodeURIComponent(project)}/attachment`,
        {
          method: 'PUT',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            snapshot: review.snapshot,
            sourceRevision: review.sourceRevision,
            acceptAuthorityWidening,
          }),
        },
      );
    } catch {
      if (!current(requestId, project, connection)) return;
      result.replaceChildren(messageBlock(
        'Attachment acceptance could not reach the API. Review the current state before retrying.',
        'project-setup-status-error',
      ));
      return;
    }

    const payload = await responseJson(response);
    if (!current(requestId, project, connection)) return;
    if (!response.ok) {
      result.replaceChildren(messageBlock(
        attachmentAcceptanceFailure(response.status),
        'project-setup-status-error',
      ));
      return;
    }

    let acceptance;
    try {
      acceptance = readProjectAttachmentAcceptance(payload, review);
    } catch {
      result.replaceChildren(messageBlock(
        'Attachment acceptance returned an incompatible success response. Reread server state before continuing.',
        'project-setup-status-error',
      ));
      return;
    }

    result.replaceChildren(messageBlock('Attachment accepted. Rereading server-owned attachment state…', 'project-setup-status-loading'));
    let rereadResponse;
    try {
      rereadResponse = await window.fetch(
        `${connection.endpoint}/api/v1/projects/${encodeURIComponent(project)}/attachment`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${connection.token}`,
          },
          cache: 'no-store',
        },
      );
    } catch {
      if (!current(requestId, project, connection)) return;
      result.replaceChildren(
        acceptanceSummary(acceptance, review),
        messageBlock(
          'The attachment was accepted, while the required accepted-state reread could not reach the API. Repository verification remains incomplete.',
          'project-setup-status-error',
        ),
      );
      return;
    }

    const rereadPayload = await responseJson(rereadResponse);
    if (!current(requestId, project, connection)) return;
    if (!rereadResponse.ok) {
      result.replaceChildren(
        acceptanceSummary(acceptance, review),
        messageBlock(
          'The attachment was accepted, while the required accepted-state reread failed. Repository verification remains incomplete.',
          'project-setup-status-error',
        ),
      );
      return;
    }

    let accepted;
    try {
      accepted = readAcceptedProjectAttachment(rereadPayload, review);
    } catch {
      result.replaceChildren(
        acceptanceSummary(acceptance, review),
        messageBlock(
          'The accepted attachment reread does not match the reviewed snapshot. Repository verification remains incomplete.',
          'project-setup-status-error',
        ),
      );
      return;
    }

    result.replaceChildren(
      acceptanceSummary(acceptance, review),
      fact('Reread attachment', accepted.id),
      fact('Reread snapshot', accepted.snapshotSha256),
      messageBlock(
        'Attachment acceptance and server-state reread are verified. Guarded get_repo plus immutable fetch_file verification still gates repository-ready.',
        'project-setup-status-note',
      ),
    );
  }

  function current(requestId, project, connection) {
    const latest = readConnection();
    return requestId === requestGeneration
      && panel.open
      && projectSelect.value === project
      && latest.endpoint === connection.endpoint
      && latest.token === connection.token;
  }

  function syncProjects() {
    const projects = [...projectFilter.options]
      .map((option) => option.value.trim())
      .filter((value) => /^[a-z0-9][a-z0-9-_]{0,79}$/u.test(value));
    const unique = [...new Set(projects)];
    const nextFingerprint = unique.join('\u0000');
    const previous = projectSelect.value;
    const filtered = unique.includes(projectFilter.value) ? projectFilter.value : '';
    const desired = filtered || (unique.includes(previous) ? previous : unique[0] || '');
    if (nextFingerprint !== projectFingerprint) {
      projectFingerprint = nextFingerprint;
      projectSelect.replaceChildren(...unique.map((project) => {
        const option = document.createElement('option');
        option.value = project;
        option.textContent = project;
        return option;
      }));
    }
    projectSelect.value = desired;
    panel.dataset.available = desired ? 'true' : 'false';
    refreshButton.disabled = !desired;
    if (panel.open && !desired) reset();
  }

  function reset() {
    invalidate();
    clearFailure();
    refreshButton.disabled = !projectSelect.value;
    status.textContent = 'waiting';
    body.replaceChildren(messageBlock('Open this card to read the selected project setup.', 'project-setup-status-empty'));
    if (panel.open) panel.open = false;
  }

  function invalidate() {
    requestGeneration += 1;
  }

  function showFailure(message) {
    refreshButton.disabled = !projectSelect.value;
    status.textContent = 'needs attention';
    error.textContent = message;
    error.hidden = false;
    body.replaceChildren(messageBlock('No compatible setup status is available yet.', 'project-setup-status-empty'));
  }

  function clearFailure() {
    error.textContent = '';
    error.hidden = true;
  }

  return {
    refresh,
    reset,
    destroy() {
      invalidate();
      projectObserver.disconnect();
      dashboardObserver.disconnect();
      connectionObserver?.disconnect();
      panel.removeEventListener('toggle', onToggle);
      refreshButton.removeEventListener('click', onRefresh);
      projectSelect.removeEventListener('change', onProjectChange);
      projectFilter.removeEventListener('change', onFilterChange);
      panel.remove();
    },
  };
}

function renderSetupStatus(container, setup) {
  const fragment = document.createDocumentFragment();
  const summary = document.createElement('section');
  summary.className = 'project-setup-status-summary';
  summary.append(
    fact('Overall', stateLabel(setup.state)),
    fact('Next required', setup.nextStep ? setupStepLabel(setup.nextStep) : 'Required path complete'),
    fact('Last verified', setup.lastVerifiedStep ? setupStepLabel(setup.lastVerifiedStep) : 'None yet'),
    fact('Observed', formatTimestamp(setup.observedAt)),
  );
  fragment.append(summary);

  const steps = document.createElement('ol');
  steps.className = 'project-setup-status-steps';
  for (const entry of setup.steps) {
    const row = document.createElement('li');
    row.dataset.state = entry.state;
    const copy = document.createElement('span');
    copy.textContent = setupStepLabel(entry.step);
    const meta = document.createElement('small');
    meta.textContent = `${entry.required ? 'required' : 'optional'} · ${stateLabel(entry.state)}`;
    row.append(copy, meta);
    steps.append(row);
  }
  fragment.append(steps);
  fragment.append(repositorySection(setup));
  container.replaceChildren(fragment);
}

function repositorySection(setup) {
  const section = document.createElement('section');
  section.className = 'project-setup-status-repository';
  const heading = document.createElement('h4');
  heading.textContent = 'Repository setup';
  section.append(heading);

  const proposal = setup.repositorySetupObservation;
  if (proposal) {
    section.append(
      messageBlock(
        'Stensibly has a saved advisory repository proposal for this project.',
        'project-setup-status-note',
      ),
      fact('Proposed repository', proposal.repositoryFullName),
      fact('Proposed default branch', proposal.defaultBranch),
      fact('Proposal source', repositorySourceLabel(proposal.sourceKind)),
      fact('Proposal fingerprint', proposal.semanticFingerprint),
      fact('Proposal observed', formatTimestamp(proposal.observedAt)),
    );
  }

  const recovery = setup.repositoryRecovery;
  if (!recovery) {
    const repositoryStep = setup.steps.find((entry) => entry.step === 'repository');
    const message = repositoryStep?.state === 'ready'
      ? 'The accepted project attachment is ready for guarded repository work.'
      : repositoryStep?.state === 'deferred'
        ? 'Repository setup is deferred for this project.'
        : 'No repository continuation is currently active.';
    section.append(messageBlock(message, 'project-setup-status-note'));
    return section;
  }

  if (recovery.state === 'repository_context_required') {
    section.append(messageBlock(
      proposal
        ? 'The repository identity is saved. Add the remaining setup choices before Stensibly can prepare an attachment plan.'
        : 'Repository context is needed before Stensibly can prepare an attachment plan.',
      'project-setup-status-note',
    ));
    const list = document.createElement('ul');
    for (const field of recovery.requiredFields) {
      if (proposal && (field === 'repositoryFullName' || field === 'defaultBranch')) continue;
      const item = document.createElement('li');
      item.textContent = contextFieldLabel(field);
      list.append(item);
    }
    section.append(list);
    return section;
  }

  section.append(
    fact('Repository', recovery.repository.fullName),
    fact('Default branch', recovery.repository.defaultBranch),
    fact('Work profile', recovery.requested.workProfile === 'draft_pr' ? 'Draft pull request' : 'Read only'),
    fact('Runner profiles', recovery.requested.runnerProfiles.join(', ')),
  );
  if (recovery.requested.checks.length) {
    const checksHeading = document.createElement('strong');
    checksHeading.textContent = 'Checks';
    const checks = document.createElement('ul');
    for (const check of recovery.requested.checks) {
      const item = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = check;
      item.append(code);
      checks.append(item);
    }
    section.append(checksHeading, checks);
  }
  section.append(
    messageBlock(
      'Next: review STENSIBLY.md and accept the attachment with explicit admin acknowledgement when authority widens.',
      'project-setup-status-note',
    ),
    messageBlock(
      'After acceptance, Stensibly rereads the accepted attachment. Guarded get_repo and immutable fetch_file verification still gate repository-ready.',
      'project-setup-status-note',
    ),
  );
  if (proposal) section.append(attachmentActionSection());
  else section.append(messageBlock(
    'A saved repository proposal is required before attachment review can start.',
    'project-setup-status-note',
  ));
  return section;
}

function attachmentActionSection() {
  const section = document.createElement('section');
  section.className = 'project-setup-attachment-action';
  section.dataset.projectAttachmentOwnerAction = 'true';
  const heading = document.createElement('h5');
  heading.textContent = 'Review project attachment';
  const note = messageBlock(
    'Paste the exact reviewed STENSIBLY.md and source revision, or generate a local draft from the saved repository plan. Source text stays in this open card and is sent only to the review/accept flow.',
    'project-setup-status-note',
  );
  const sourceLabel = document.createElement('label');
  sourceLabel.textContent = 'STENSIBLY.md source';
  const source = document.createElement('textarea');
  source.dataset.projectAttachmentSource = 'true';
  source.rows = 14;
  source.spellcheck = false;
  source.autocomplete = 'off';
  source.placeholder = 'Paste the exact reviewed STENSIBLY.md source here.';
  sourceLabel.append(source);
  const revisionLabel = document.createElement('label');
  revisionLabel.textContent = 'Source revision';
  const revision = document.createElement('input');
  revision.dataset.projectAttachmentRevision = 'true';
  revision.type = 'text';
  revision.maxLength = 240;
  revision.autocomplete = 'off';
  revision.placeholder = 'Exact commit/revision, or generate a local draft revision';
  revisionLabel.append(revision);
  const controls = document.createElement('div');
  controls.className = 'project-setup-attachment-controls';
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.className = 'secondary';
  generate.dataset.projectAttachmentGenerate = 'true';
  generate.textContent = 'generate local draft';
  const review = document.createElement('button');
  review.type = 'button';
  review.dataset.projectAttachmentReview = 'true';
  review.textContent = 'review attachment';
  controls.append(generate, review);
  const result = document.createElement('div');
  result.className = 'project-setup-attachment-result';
  result.dataset.projectAttachmentResult = 'true';
  result.setAttribute('aria-live', 'polite');
  section.append(heading, note, sourceLabel, revisionLabel, controls, result);
  return section;
}

function renderAttachmentReviewDecision(container, review, actions) {
  const summary = document.createElement('section');
  summary.className = 'project-setup-attachment-review';
  summary.append(
    fact('Repository', review.repositoryFullName),
    fact('Default branch', review.defaultBranch),
    fact('Source revision', review.sourceRevision),
    fact('Snapshot fingerprint', review.snapshot.snapshotSha256),
    fact('Proposal fingerprint', review.proposalSemanticFingerprint),
    fact('Authority widening', review.requiresAuthorityWidening ? 'explicit acknowledgement required' : 'no widening acknowledgement required'),
  );
  if (review.exactReplay) {
    summary.append(messageBlock(
      'This exact snapshot and source revision already match the accepted attachment.',
      'project-setup-status-note',
    ));
  } else if (review.diff) {
    const heading = document.createElement('strong');
    heading.textContent = 'Attachment diff';
    const list = document.createElement('ul');
    for (const change of review.diff.changes) {
      const item = document.createElement('li');
      item.textContent = `${change.field}: ${change.kind} · ${change.authorityEffect}`;
      list.append(item);
    }
    summary.append(heading, list);
  } else {
    summary.append(messageBlock(
      'This is the first accepted attachment for the project.',
      'project-setup-status-note',
    ));
  }

  const controls = document.createElement('div');
  controls.className = 'project-setup-attachment-controls';
  let acknowledgement = null;
  if (review.requiresAuthorityWidening) {
    const label = document.createElement('label');
    label.className = 'project-setup-attachment-ack';
    acknowledgement = document.createElement('input');
    acknowledgement.type = 'checkbox';
    acknowledgement.dataset.projectAttachmentWideningAck = 'true';
    const copy = document.createElement('span');
    copy.textContent = 'I reviewed this exact attachment and acknowledge the declared authority widening.';
    label.append(acknowledgement, copy);
    summary.append(label);
  }
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = 'cancel review';
  cancel.addEventListener('click', actions.cancel);
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.textContent = review.exactReplay ? 'confirm exact replay' : 'accept attachment';
  accept.disabled = review.requiresAuthorityWidening;
  acknowledgement?.addEventListener('change', () => {
    accept.disabled = !acknowledgement.checked;
  });
  accept.addEventListener('click', () => {
    if (review.requiresAuthorityWidening && !acknowledgement?.checked) return;
    cancel.disabled = true;
    accept.disabled = true;
    void actions.accept(review.requiresAuthorityWidening === true);
  });
  controls.append(cancel, accept);
  summary.append(controls);
  container.replaceChildren(summary);
}

function acceptanceSummary(acceptance, review) {
  const section = document.createElement('section');
  section.className = 'project-setup-attachment-review';
  section.append(
    fact('Accepted attachment', acceptance.attachment.id),
    fact('Accepted source revision', acceptance.attachment.sourceRevision),
    fact('Accepted snapshot', acceptance.attachment.snapshotSha256),
    fact('Acceptance result', acceptance.replayed ? 'exact replay' : 'accepted'),
    fact('Widening acknowledgement', review.requiresAuthorityWidening ? 'recorded' : 'not required'),
  );
  return section;
}

function repositorySourceLabel(sourceKind) {
  return sourceKind === 'operator_supplied' ? 'Operator supplied' : 'GitHub conversation context';
}

function fact(label, value) {
  const row = document.createElement('div');
  const key = document.createElement('span');
  key.textContent = label;
  const content = document.createElement('strong');
  content.textContent = value;
  row.append(key, content);
  return row;
}

function messageBlock(message, className) {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = message;
  return element;
}

function contextFieldLabel(field) {
  switch (field) {
    case 'repositoryFullName': return 'Repository';
    case 'defaultBranch': return 'Default branch';
    case 'runnerProfiles': return 'Runner profiles';
    case 'workProfile': return 'Repository work profile';
    case 'checks': return 'Checks';
    default: return 'Repository context';
  }
}

function stateLabel(value) {
  return String(value || '').replaceAll('_', ' ');
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
}

function httpFailure(status) {
  if (status === 401) return 'Sign in or reconnect before reading setup status.';
  if (status === 403) return 'This connection cannot read setup status for the selected project.';
  if (status === 404) return 'Setup status is unavailable on this server or project.';
  if (status === 400) return 'The server rejected this setup-status request.';
  if (status >= 500) return 'The server could not read setup status. Retry after the service recovers.';
  return 'Setup status could not be read.';
}

function attachmentReviewFailure(status) {
  if (status === 401) return 'Reconnect before reviewing a project attachment.';
  if (status === 403) return 'Admin access for this project is required to review an attachment.';
  if (status === 409) return 'The saved repository proposal is missing or changed. Refresh setup status before reviewing.';
  if (status === 400) return 'The reviewed source does not match the current project and saved repository proposal.';
  if (status >= 500) return 'The server could not prepare the attachment review. Retry after the service recovers.';
  return 'The attachment review could not be prepared.';
}

function attachmentAcceptanceFailure(status) {
  if (status === 401) return 'Reconnect before accepting a project attachment.';
  if (status === 403) return 'Admin access for this project is required to accept an attachment.';
  if (status === 409) return 'The attachment requires a fresh authority-widening acknowledgement. Review the current source again.';
  if (status === 400) return 'The reviewed attachment is stale or invalid. Refresh setup status and review again.';
  if (status >= 500) return 'The server could not settle attachment acceptance. Reread current state before retrying.';
  return 'The attachment could not be accepted.';
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readConnection() {
  return { endpoint: storedEndpoint(), token: storedToken() };
}

function storedEndpoint() {
  try {
    const value = String(localStorage.getItem(ENDPOINT_STORAGE_KEY) || DEFAULT_ENDPOINT).trim();
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      ? parsed.origin
      : DEFAULT_ENDPOINT;
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

function storedToken() {
  try {
    return String(sessionStorage.getItem(TOKEN_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function installStylesheet() {
  if (document.querySelector('link[href="/project-setup-status.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/project-setup-status.css';
  document.head.append(link);
}

function panelMarkup() {
  return `<details class="project-setup-status" id="project-setup-status-panel" data-available="false">
    <summary class="project-setup-status-head">
      <div><p class="eyebrow">Onboarding</p><h3>Project setup</h3></div>
      <span id="project-setup-status-state" role="status">waiting</span>
    </summary>
    <div class="project-setup-status-content">
      <div class="project-setup-status-toolbar">
        <label>Project<select id="project-setup-status-project" aria-label="Setup-status project"></select></label>
        <button class="secondary" id="project-setup-status-refresh" type="button">refresh</button>
      </div>
      <p class="project-setup-status-error" id="project-setup-status-error" role="alert" hidden></p>
      <div class="project-setup-status-body" id="project-setup-status-body">
        <p class="project-setup-status-empty">Open this card to read the selected project setup.</p>
      </div>
      <p class="project-setup-status-footnote">Setup status is read-only. Attachment review and acceptance run only through explicit admin actions in this card.</p>
    </div>
  </details>`;
}
