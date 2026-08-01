export * from "./synchronization-state-base.js";

import {
  compileSynchronizationState as compileSynchronizationStateBase,
  fingerprintSynchronizationCoordinationInput as fingerprintSynchronizationCoordinationInputBase,
} from "./synchronization-state-base.js";
import { snapshotSynchronizationInput } from "./synchronization-descriptor-snapshot.js";

export function compileSynchronizationState(
  input: unknown,
): ReturnType<typeof compileSynchronizationStateBase> {
  return compileSynchronizationStateBase(snapshotSynchronizationInput(input));
}

export function fingerprintSynchronizationCoordinationInput(
  input: unknown,
): string {
  return fingerprintSynchronizationCoordinationInputBase(
    snapshotSynchronizationInput(input),
  );
}
