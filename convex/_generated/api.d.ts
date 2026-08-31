/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountUsageReservations from "../accountUsageReservations.js";
import type * as accountUsageSchema from "../accountUsageSchema.js";
import type * as accounts from "../accounts.js";
import type * as applicationLaneBindingSchema from "../applicationLaneBindingSchema.js";
import type * as applicationLaneBindings from "../applicationLaneBindings.js";
import type * as applicationLaneWakeDispatch from "../applicationLaneWakeDispatch.js";
import type * as artifacts from "../artifacts.js";
import type * as callsignLeaseSchema from "../callsignLeaseSchema.js";
import type * as callsignLeases from "../callsignLeases.js";
import type * as claims from "../claims.js";
import type * as completionContinuations from "../completionContinuations.js";
import type * as continuationEdits from "../continuationEdits.js";
import type * as continuationSupervisor from "../continuationSupervisor.js";
import type * as continuations from "../continuations.js";
import type * as dependencies from "../dependencies.js";
import type * as events from "../events.js";
import type * as exactDispatch from "../exactDispatch.js";
import type * as githubProjectContexts from "../githubProjectContexts.js";
import type * as githubProviderReceipts from "../githubProviderReceipts.js";
import type * as githubPublicEventsPollState from "../githubPublicEventsPollState.js";
import type * as githubRepositoryObservations from "../githubRepositoryObservations.js";
import type * as githubRepositoryWrites from "../githubRepositoryWrites.js";
import type * as gmailMailboxDisposition from "../gmailMailboxDisposition.js";
import type * as gmailMailboxDispositionSchema from "../gmailMailboxDispositionSchema.js";
import type * as historyCapabilities from "../historyCapabilities.js";
import type * as itemControl from "../itemControl.js";
import type * as itemReservations from "../itemReservations.js";
import type * as itemRuns from "../itemRuns.js";
import type * as items from "../items.js";
import type * as lazyWorkstationCommands from "../lazyWorkstationCommands.js";
import type * as lib_callsign from "../lib/callsign.js";
import type * as lib_claimActivity from "../lib/claimActivity.js";
import type * as lib_claimState from "../lib/claimState.js";
import type * as lib_dataModel from "../lib/dataModel.js";
import type * as lib_dependencyVisibility from "../lib/dependencyVisibility.js";
import type * as lib_domain from "../lib/domain.js";
import type * as lib_exactDispatch from "../lib/exactDispatch.js";
import type * as lib_executionEnvelope from "../lib/executionEnvelope.js";
import type * as lib_itemHistory from "../lib/itemHistory.js";
import type * as lib_ledgerEventActivity from "../lib/ledgerEventActivity.js";
import type * as lib_orchestratorActivityStore from "../lib/orchestratorActivityStore.js";
import type * as lib_reservationVisibility from "../lib/reservationVisibility.js";
import type * as lib_runVisibility from "../lib/runVisibility.js";
import type * as lib_server from "../lib/server.js";
import type * as lib_validators from "../lib/validators.js";
import type * as mailCorrespondence from "../mailCorrespondence.js";
import type * as mailOutbound from "../mailOutbound.js";
import type * as mailOutboundSchema from "../mailOutboundSchema.js";
import type * as mailSemanticAdmission from "../mailSemanticAdmission.js";
import type * as mailSemanticAdmissionIndexes from "../mailSemanticAdmissionIndexes.js";
import type * as mailSemanticAdmissionSchema from "../mailSemanticAdmissionSchema.js";
import type * as mailboxIntake from "../mailboxIntake.js";
import type * as mailboxIntakeSchema from "../mailboxIntakeSchema.js";
import type * as mcpOAuth from "../mcpOAuth.js";
import type * as mcpOAuthClientLifecycle from "../mcpOAuthClientLifecycle.js";
import type * as mcpOAuthClientLifecycleAudit from "../mcpOAuthClientLifecycleAudit.js";
import type * as mcpOAuthClientRegistration from "../mcpOAuthClientRegistration.js";
import type * as mcpSetupEvidence from "../mcpSetupEvidence.js";
import type * as migration from "../migration.js";
import type * as oauthStates from "../oauthStates.js";
import type * as operationReceipts from "../operationReceipts.js";
import type * as operationWorkflows from "../operationWorkflows.js";
import type * as orchestratorActivity from "../orchestratorActivity.js";
import type * as orchestratorActivitySchema from "../orchestratorActivitySchema.js";
import type * as outlookRuntime from "../outlookRuntime.js";
import type * as outlookRuntimeSchema from "../outlookRuntimeSchema.js";
import type * as projectAttachments from "../projectAttachments.js";
import type * as projectRepositorySetupObservations from "../projectRepositorySetupObservations.js";
import type * as projects from "../projects.js";
import type * as providerCapacities from "../providerCapacities.js";
import type * as providerMembershipAudit from "../providerMembershipAudit.js";
import type * as queuedRuns from "../queuedRuns.js";
import type * as refs from "../refs.js";
import type * as reservations from "../reservations.js";
import type * as runnerAdapterCommandRecoveries from "../runnerAdapterCommandRecoveries.js";
import type * as runnerAdapterCommandRecoverySchema from "../runnerAdapterCommandRecoverySchema.js";
import type * as runnerAdapterCommands from "../runnerAdapterCommands.js";
import type * as runnerRuns from "../runnerRuns.js";
import type * as runs from "../runs.js";
import type * as tokens from "../tokens.js";
import type * as workSelectionClaims from "../workSelectionClaims.js";
import type * as workerEnrolmentSchema from "../workerEnrolmentSchema.js";
import type * as workerEnrolments from "../workerEnrolments.js";
import type * as workstationCommands from "../workstationCommands.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountUsageReservations: typeof accountUsageReservations;
  accountUsageSchema: typeof accountUsageSchema;
  accounts: typeof accounts;
  applicationLaneBindingSchema: typeof applicationLaneBindingSchema;
  applicationLaneBindings: typeof applicationLaneBindings;
  applicationLaneWakeDispatch: typeof applicationLaneWakeDispatch;
  artifacts: typeof artifacts;
  callsignLeaseSchema: typeof callsignLeaseSchema;
  callsignLeases: typeof callsignLeases;
  claims: typeof claims;
  completionContinuations: typeof completionContinuations;
  continuationEdits: typeof continuationEdits;
  continuationSupervisor: typeof continuationSupervisor;
  continuations: typeof continuations;
  dependencies: typeof dependencies;
  events: typeof events;
  exactDispatch: typeof exactDispatch;
  githubProjectContexts: typeof githubProjectContexts;
  githubProviderReceipts: typeof githubProviderReceipts;
  githubPublicEventsPollState: typeof githubPublicEventsPollState;
  githubRepositoryObservations: typeof githubRepositoryObservations;
  githubRepositoryWrites: typeof githubRepositoryWrites;
  gmailMailboxDisposition: typeof gmailMailboxDisposition;
  gmailMailboxDispositionSchema: typeof gmailMailboxDispositionSchema;
  historyCapabilities: typeof historyCapabilities;
  itemControl: typeof itemControl;
  itemReservations: typeof itemReservations;
  itemRuns: typeof itemRuns;
  items: typeof items;
  lazyWorkstationCommands: typeof lazyWorkstationCommands;
  "lib/callsign": typeof lib_callsign;
  "lib/claimActivity": typeof lib_claimActivity;
  "lib/claimState": typeof lib_claimState;
  "lib/dataModel": typeof lib_dataModel;
  "lib/dependencyVisibility": typeof lib_dependencyVisibility;
  "lib/domain": typeof lib_domain;
  "lib/exactDispatch": typeof lib_exactDispatch;
  "lib/executionEnvelope": typeof lib_executionEnvelope;
  "lib/itemHistory": typeof lib_itemHistory;
  "lib/ledgerEventActivity": typeof lib_ledgerEventActivity;
  "lib/orchestratorActivityStore": typeof lib_orchestratorActivityStore;
  "lib/reservationVisibility": typeof lib_reservationVisibility;
  "lib/runVisibility": typeof lib_runVisibility;
  "lib/server": typeof lib_server;
  "lib/validators": typeof lib_validators;
  mailCorrespondence: typeof mailCorrespondence;
  mailOutbound: typeof mailOutbound;
  mailOutboundSchema: typeof mailOutboundSchema;
  mailSemanticAdmission: typeof mailSemanticAdmission;
  mailSemanticAdmissionIndexes: typeof mailSemanticAdmissionIndexes;
  mailSemanticAdmissionSchema: typeof mailSemanticAdmissionSchema;
  mailboxIntake: typeof mailboxIntake;
  mailboxIntakeSchema: typeof mailboxIntakeSchema;
  mcpOAuth: typeof mcpOAuth;
  mcpOAuthClientLifecycle: typeof mcpOAuthClientLifecycle;
  mcpOAuthClientLifecycleAudit: typeof mcpOAuthClientLifecycleAudit;
  mcpOAuthClientRegistration: typeof mcpOAuthClientRegistration;
  mcpSetupEvidence: typeof mcpSetupEvidence;
  migration: typeof migration;
  oauthStates: typeof oauthStates;
  operationReceipts: typeof operationReceipts;
  operationWorkflows: typeof operationWorkflows;
  orchestratorActivity: typeof orchestratorActivity;
  orchestratorActivitySchema: typeof orchestratorActivitySchema;
  outlookRuntime: typeof outlookRuntime;
  outlookRuntimeSchema: typeof outlookRuntimeSchema;
  projectAttachments: typeof projectAttachments;
  projectRepositorySetupObservations: typeof projectRepositorySetupObservations;
  projects: typeof projects;
  providerCapacities: typeof providerCapacities;
  providerMembershipAudit: typeof providerMembershipAudit;
  queuedRuns: typeof queuedRuns;
  refs: typeof refs;
  reservations: typeof reservations;
  runnerAdapterCommandRecoveries: typeof runnerAdapterCommandRecoveries;
  runnerAdapterCommandRecoverySchema: typeof runnerAdapterCommandRecoverySchema;
  runnerAdapterCommands: typeof runnerAdapterCommands;
  runnerRuns: typeof runnerRuns;
  runs: typeof runs;
  tokens: typeof tokens;
  workSelectionClaims: typeof workSelectionClaims;
  workerEnrolmentSchema: typeof workerEnrolmentSchema;
  workerEnrolments: typeof workerEnrolments;
  workstationCommands: typeof workstationCommands;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
