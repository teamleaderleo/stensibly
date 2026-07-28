import { v } from "convex/values";
import {
  ARTIFACT_HISTORY_OVERFLOW_CODE,
  ITEM_HISTORY_CONTRACT_VERSION,
  MAX_DIRECT_VISIBLE_EVENTS,
  MAX_ITEM_DETAIL_VISIBLE_EVENTS,
  MAX_ITEM_EVENT_SCAN_BYTES,
  MAX_ITEM_EVENT_SCAN_ROWS,
  MAX_PUBLIC_ITEM_ARTIFACTS,
} from "./lib/itemHistory";
import { requireServiceSecret } from "./lib/domain";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const boundedHistoryCapability = v.object({
  version: v.literal(ITEM_HISTORY_CONTRACT_VERSION),
  itemDetailVisibleEventLimit: v.literal(MAX_ITEM_DETAIL_VISIBLE_EVENTS),
  directVisibleEventLimit: v.literal(MAX_DIRECT_VISIBLE_EVENTS),
  physicalEventRowLimit: v.literal(MAX_ITEM_EVENT_SCAN_ROWS),
  physicalEventByteLimit: v.literal(MAX_ITEM_EVENT_SCAN_BYTES),
  artifactLimit: v.literal(MAX_PUBLIC_ITEM_ARTIFACTS),
  artifactOverflowCode: v.literal(ARTIFACT_HISTORY_OVERFLOW_CODE),
  boundedItemControl: v.literal(true),
  boundedDirectEvents: v.literal(true),
  boundedArtifacts: v.literal(true),
});

export const get = query({
  args: serviceArgs,
  returns: boundedHistoryCapability,
  handler: async (_ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    return {
      version: ITEM_HISTORY_CONTRACT_VERSION,
      itemDetailVisibleEventLimit: MAX_ITEM_DETAIL_VISIBLE_EVENTS,
      directVisibleEventLimit: MAX_DIRECT_VISIBLE_EVENTS,
      physicalEventRowLimit: MAX_ITEM_EVENT_SCAN_ROWS,
      physicalEventByteLimit: MAX_ITEM_EVENT_SCAN_BYTES,
      artifactLimit: MAX_PUBLIC_ITEM_ARTIFACTS,
      artifactOverflowCode: ARTIFACT_HISTORY_OVERFLOW_CODE,
      boundedItemControl: true,
      boundedDirectEvents: true,
      boundedArtifacts: true,
    } as const;
  },
});
