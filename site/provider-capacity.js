const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[bot\])?$/;
const commentIdPattern = /^\d{1,30}$/;
const unknownReasons = new Set(['not_observed', 'observation_stale', 'refill_window_elapsed']);
const unavailableReasons = new Set(['quota_exhausted', 'provider_reported_unavailable']);

export function validateProviderCapacityScope(value) {
  if (!isRecord(value)) throw new TypeError('CodeRabbit capacity scope must be an object.');
  const repository = boundedText(value.repository, 'Repository', 200, repositoryPattern);
  const subjectLogin = boundedText(value.subjectLogin, 'Subject login', 120, loginPattern);
  return { repository, subjectLogin };
}

export function readProviderCapacity(payload, expectedScope) {
  const scope = validateProviderCapacityScope(expectedScope);
  if (!isRecord(payload) || !isRecord(payload.capacity)) {
    throw new TypeError('The endpoint returned an incompatible CodeRabbit capacity response.');
  }
  const value = payload.capacity;
  if (value.provider !== 'coderabbit') throw new TypeError('Capacity provider must be coderabbit.');
  const repository = boundedText(value.repository, 'Capacity repository', 200, repositoryPattern);
  const subjectLogin = boundedText(value.subjectLogin, 'Capacity subject', 120, loginPattern);
  if (repository !== scope.repository || subjectLogin !== scope.subjectLogin) {
    throw new TypeError('The capacity response does not match the requested repository and subject.');
  }
  if (value.subjectBasis !== 'pull_request_author_proxy') {
    throw new TypeError('Capacity subject attribution is unsupported.');
  }
  if (!['available', 'unavailable', 'unknown'].includes(value.state)) {
    throw new TypeError('Capacity state is unsupported.');
  }

  const remaining = nullableInteger(value.remaining, 'Remaining reviews', 0, 1_000);
  const limit = nullableInteger(value.limit, 'Review limit', 1, 1_000);
  if ((remaining === null) !== (limit === null)) {
    throw new TypeError('Remaining reviews and review limit must be supplied together.');
  }
  if (remaining !== null && limit !== null && remaining > limit) {
    throw new TypeError('Remaining reviews cannot exceed the review limit.');
  }

  const observedAt = nullableTimestamp(value.observedAt, 'Observation time');
  const receivedAt = nullableTimestamp(value.receivedAt, 'Receipt time');
  const staleAt = nullableTimestamp(value.staleAt, 'Stale time');
  const refillAt = nullableTimestamp(value.refillAt, 'Refill time');
  const nextAvailableAt = nullableTimestamp(value.nextAvailableAt, 'Next available time');
  const source = readSource(value.source);
  validateObservedTimes(observedAt, receivedAt, staleAt, refillAt);

  if (value.state === 'available') {
    if (
      value.reason !== null
      || observedAt === null
      || receivedAt === null
      || staleAt === null
      || source === null
      || nextAvailableAt !== null
    ) {
      throw new TypeError('Available capacity requires fresh observation evidence.');
    }
    if (remaining === 0) throw new TypeError('Available capacity cannot report zero remaining reviews.');
  } else if (value.state === 'unavailable') {
    if (
      !unavailableReasons.has(value.reason)
      || observedAt === null
      || receivedAt === null
      || staleAt === null
      || refillAt === null
      || nextAvailableAt === null
      || source === null
      || staleAt !== refillAt
      || nextAvailableAt !== refillAt
    ) {
      throw new TypeError('Unavailable capacity requires bounded refill evidence.');
    }
    if (remaining !== null && remaining !== 0) {
      throw new TypeError('Unavailable counted capacity must report zero remaining reviews.');
    }
  } else {
    if (!unknownReasons.has(value.reason)) throw new TypeError('Unknown capacity requires a supported reason.');
    if (value.reason === 'not_observed') {
      if (
        remaining !== null
        || limit !== null
        || [observedAt, receivedAt, staleAt, refillAt, nextAvailableAt, source]
          .some((entry) => entry !== null)
      ) {
        throw new TypeError('Unobserved capacity must not claim provider evidence.');
      }
    } else {
      if (observedAt === null || receivedAt === null || staleAt === null || source === null) {
        throw new TypeError('Expired capacity requires the prior bounded observation evidence.');
      }
      if (nextAvailableAt !== null) {
        throw new TypeError('Unknown capacity must not claim a next available time.');
      }
      if (value.reason === 'refill_window_elapsed' && refillAt === null) {
        throw new TypeError('Elapsed refill capacity requires the prior refill evidence.');
      }
    }
  }

  return {
    provider: 'coderabbit',
    repository,
    subjectLogin,
    subjectBasis: 'pull_request_author_proxy',
    state: value.state,
    reason: value.reason,
    remaining,
    limit,
    observedAt,
    receivedAt,
    staleAt,
    refillAt,
    nextAvailableAt,
    source,
  };
}

export function describeProviderCapacity(capacity, now = Date.now()) {
  if (!Number.isFinite(now)) throw new TypeError('Display time must be finite.');
  const quota = capacity.remaining === null
    ? 'Provider did not supply a remaining count.'
    : `${capacity.remaining} of ${capacity.limit} review${capacity.limit === 1 ? '' : 's'} remaining.`;
  const evidenceAge = capacity.observedAt === null
    ? 'No provider observation has been recorded.'
    : `Observed ${ageLabel(now - Date.parse(capacity.observedAt))}.`;
  let timing;
  if (capacity.state === 'available') {
    timing = `Fresh until ${formatTime(capacity.staleAt)} unless another review consumes capacity first.`;
  } else if (capacity.state === 'unavailable') {
    timing = `Provider-reported refill ${formatTime(capacity.nextAvailableAt)}.`;
  } else if (capacity.reason === 'observation_stale') {
    timing = `Last availability evidence expired ${formatTime(capacity.staleAt)}.`;
  } else if (capacity.reason === 'refill_window_elapsed') {
    timing = 'The reported refill boundary passed; a fresh provider observation is required.';
  } else {
    timing = 'Run a separate quota-status check only when fresh visibility is needed.';
  }
  return {
    statusLabel: capacity.state,
    quota,
    evidenceAge,
    timing,
    scope: `${capacity.repository} · ${capacity.subjectLogin} · PR-author proxy`,
    sourceLabel: capacity.source
      ? `PR #${capacity.source.pullRequestNumber} · comment ${capacity.source.commentId}`
      : 'No source observation',
    sourceHref: capacity.source
      ? `https://github.com/${capacity.repository}/pull/${capacity.source.pullRequestNumber}#issuecomment-${capacity.source.commentId}`
      : null,
  };
}

function validateObservedTimes(observedAt, receivedAt, staleAt, refillAt) {
  if (observedAt === null) {
    if (receivedAt !== null || staleAt !== null || refillAt !== null) {
      throw new TypeError('Capacity timestamps require an observation time.');
    }
    return;
  }
  if (receivedAt === null || staleAt === null) {
    throw new TypeError('Observed capacity requires receipt and stale times.');
  }
  const observed = Date.parse(observedAt);
  const received = Date.parse(receivedAt);
  const stale = Date.parse(staleAt);
  if (observed > received + 5 * 60 * 1_000 || stale <= observed) {
    throw new TypeError('Capacity observation timing is inconsistent.');
  }
  if (refillAt !== null) {
    const refill = Date.parse(refillAt);
    if (refill <= observed || stale > refill) {
      throw new TypeError('Capacity refill timing is inconsistent.');
    }
  }
}

function readSource(value) {
  if (value === null) return null;
  if (!isRecord(value) || !Number.isInteger(value.pullRequestNumber) || value.pullRequestNumber < 1) {
    throw new TypeError('Capacity source pull request is invalid.');
  }
  if (typeof value.commentId !== 'string' || !commentIdPattern.test(value.commentId)) {
    throw new TypeError('Capacity source comment is invalid.');
  }
  return { pullRequestNumber: value.pullRequestNumber, commentId: value.commentId };
}

function boundedText(value, label, maximum, pattern) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || unsafeTextPattern.test(normalized) || !pattern.test(normalized)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
}

function nullableInteger(value, label, minimum, maximum) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function nullableTimestamp(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function ageLabel(elapsed) {
  const safe = Math.max(0, elapsed);
  if (safe < 60_000) return `${Math.floor(safe / 1_000)}s ago`;
  if (safe < 3_600_000) return `${Math.floor(safe / 60_000)}m ago`;
  return `${Math.floor(safe / 3_600_000)}h ago`;
}

function formatTime(value) {
  if (value === null) return 'not supplied';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
