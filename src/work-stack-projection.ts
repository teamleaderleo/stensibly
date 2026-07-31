import {
  admitProjectionInput,
  deepFreeze,
  fingerprint,
} from "./work-stack-projection-admission.ts";
import {
  compareHot,
  compareIndex,
  compareReview,
  compareWarm,
  inclusionReason,
  isHot,
  toHotRow,
  toIndexRow,
  toReviewRow,
  toSummaryRow,
} from "./work-stack-projection-ordering.ts";
import {
  WORK_STACK_LIMITS,
  WORK_STACK_PROJECTION_VERSION,
  type WorkStackFocusedDetail,
  type WorkStackProjection,
  type WorkStackProjectionInput,
  type WorkStackRecordInput,
} from "./work-stack-projection-types.ts";
import {
  assertCanonicalJsonByteBudget,
  compareCodeUnits,
} from "./work-stack-projection-validation.ts";

export * from "./work-stack-projection-types.ts";

export function compileWorkStackProjection(
  input: WorkStackProjectionInput,
): WorkStackProjection {
  const admitted = admitProjectionInput(input);
  const records = admitted.records;
  const recordById = new Map(records.map((record) => [record.id, record]));
  if (admitted.selectedId !== null && !recordById.has(admitted.selectedId)) {
    throw new TypeError("Selected work-stack record does not exist");
  }

  const hotAll = records.filter(isHot).sort(compareHot);
  const reviewAll = records
    .filter((record) => record.reviewState === "actionable")
    .sort(compareReview);
  const hotIds = new Set(hotAll.map((record) => record.id));
  const reviewIds = new Set(reviewAll.map((record) => record.id));
  const warmAll = records
    .filter((record) => record.state !== "archived")
    .map((record) => ({
      record,
      reason: inclusionReason(record, hotIds, reviewIds),
    }))
    .sort(compareWarm);
  const indexAll = [...records].sort((left, right) =>
    compareIndex(left, right, hotIds, reviewIds));

  const canonicalFingerprintRecords = [...records].sort((left, right) =>
    compareCodeUnits(left.id, right.id));
  const snapshotFingerprint = fingerprint({
    version: WORK_STACK_PROJECTION_VERSION,
    project: admitted.project,
    observedAt: admitted.observedAt,
    records: canonicalFingerprintRecords,
  });

  const projection: WorkStackProjection = {
    version: WORK_STACK_PROJECTION_VERSION,
    project: admitted.project,
    observedAt: admitted.observedAt,
    snapshotFingerprint,
    policy: {
      hotLimit: admitted.limits.hot,
      reviewLimit: admitted.limits.review,
      warmLimit: admitted.limits.warm,
      indexLimit: admitted.limits.index,
      maxOutputBytes: WORK_STACK_LIMITS.maxProjectionBytes,
      hotOrdering: "attention_then_oldest_unmet_then_stalest_evidence",
      reviewOrdering: "oldest_actionable_first",
      indexOrdering: "hot_then_review_then_non_archived_recent_then_archived_recent",
      detailLoading: "explicit_selection_only",
      pagination: "adapter_owned",
    },
    counts: {
      available: records.length,
      hotAvailable: hotAll.length,
      hotReturned: Math.min(hotAll.length, admitted.limits.hot),
      reviewAvailable: reviewAll.length,
      reviewReturned: Math.min(reviewAll.length, admitted.limits.review),
      warmAvailable: warmAll.length,
      warmReturned: Math.min(warmAll.length, admitted.limits.warm),
      indexReturned: Math.min(indexAll.length, admitted.limits.index),
    },
    truncation: {
      hot: hotAll.length > admitted.limits.hot,
      review: reviewAll.length > admitted.limits.review,
      warm: warmAll.length > admitted.limits.warm,
      index: indexAll.length > admitted.limits.index,
    },
    hot: hotAll.slice(0, admitted.limits.hot).map(toHotRow),
    reviewQueue: reviewAll
      .slice(0, admitted.limits.review)
      .map(toReviewRow),
    warmSummaries: warmAll
      .slice(0, admitted.limits.warm)
      .map(({ record, reason }) => toSummaryRow(record, reason)),
    coldIndex: indexAll.slice(0, admitted.limits.index).map(toIndexRow),
    focusedDetail: admitted.selectedId === null
      ? null
      : copyRecord(recordById.get(admitted.selectedId)!),
    authorizesOperation: false,
    authorizesMutation: false,
  };
  assertCanonicalJsonByteBudget(
    projection,
    WORK_STACK_LIMITS.maxProjectionBytes,
    "work-stack projection",
  );
  return deepFreeze(projection);
}

function copyRecord(record: WorkStackRecordInput): WorkStackFocusedDetail {
  return {
    ...record,
    links: record.links.map((link) => ({ ...link })),
  };
}
