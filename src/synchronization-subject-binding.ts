export * from "./synchronization-subject-binding-base.js";

import {
  compileSubjectBoundSynchronizationState as compileSubjectBoundSynchronizationStateBase,
  fingerprintSubjectBoundSynchronizationCoordinationInput as fingerprintSubjectBoundSynchronizationCoordinationInputBase,
  fingerprintSynchronizationSubject as fingerprintSynchronizationSubjectBase,
} from "./synchronization-subject-binding-base.js";
import { snapshotSynchronizationInput } from "./synchronization-descriptor-snapshot.js";

export function fingerprintSynchronizationSubject(subject: unknown): string {
  return fingerprintSynchronizationSubjectBase(snapshotSynchronizationInput(subject));
}

export function fingerprintSubjectBoundSynchronizationCoordinationInput(
  input: unknown,
): string {
  return fingerprintSubjectBoundSynchronizationCoordinationInputBase(
    snapshotSynchronizationInput(input),
  );
}

export function compileSubjectBoundSynchronizationState(
  input: unknown,
): ReturnType<typeof compileSubjectBoundSynchronizationStateBase> {
  return compileSubjectBoundSynchronizationStateBase(
    snapshotSynchronizationInput(input),
  );
}
