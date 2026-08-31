import { makeFunctionReference } from "convex/server";

const queryRef = (name: string) => makeFunctionReference<"query">(name);
const mutationRef = (name: string) => makeFunctionReference<"mutation">(name);

export const convexApi = {
  projects: {
    list: queryRef("projects:list"),
    brief: queryRef("projects:brief"),
  },
  projectAttachments: {
    getCurrent: queryRef("projectAttachments:getCurrent"),
    accept: mutationRef("projectAttachments:accept"),
  },
  historyCapabilities: {
    get: queryRef("historyCapabilities:get"),
  },
  items: {
    create: mutationRef("items:create"),
    list: queryRef("items:list"),
    get: queryRef("items:get"),
    complete: mutationRef("items:complete"),
    handoff: mutationRef("items:handoff"),
    block: mutationRef("items:block"),
    unblock: mutationRef("items:unblock"),
  },
  itemControl: {
    get: queryRef("itemControl:get"),
  },
  itemReservations: {
    list: queryRef("itemReservations:list"),
  },
  itemRuns: {
    list: queryRef("itemRuns:list"),
  },
  queuedRuns: {
    finish: mutationRef("queuedRuns:finish"),
  },
  runnerRuns: {
    claim: mutationRef("runnerRuns:claim"),
    reconcile: mutationRef("runnerRuns:reconcile"),
    get: mutationRef("runnerRuns:get"),
    list: mutationRef("runnerRuns:list"),
    heartbeat: mutationRef("runnerRuns:heartbeat"),
    transition: mutationRef("runnerRuns:transition"),
  },
  runnerAdapterCommands: {
    get: queryRef("runnerAdapterCommands:get"),
    reserve: mutationRef("runnerAdapterCommands:reserve"),
    settle: mutationRef("runnerAdapterCommands:settle"),
  },
  lazyWorkstationCommands: {
    reserve: mutationRef("lazyWorkstationCommands:reserve"),
  },
  workstationCommands: {
    reserve: mutationRef("workstationCommands:reserve"),
  },
  runnerAdapterCommandRecoveries: {
    claim: mutationRef("runnerAdapterCommandRecoveries:claim"),
  },
  mailOutbound: {
    reserveThread: mutationRef("mailOutbound:reserveThread"),
    getThreadByHandle: queryRef("mailOutbound:getThreadByHandle"),
    getThreadBySource: queryRef("mailOutbound:getThreadBySource"),
    updateThread: mutationRef("mailOutbound:updateThread"),
    getProviderProjection: queryRef("mailOutbound:getProviderProjection"),
    reserveEffect: mutationRef("mailOutbound:reserveEffect"),
    settleEffect: mutationRef("mailOutbound:settleEffect"),
    getEffect: queryRef("mailOutbound:getEffect"),
    getEffectByProviderMessage: queryRef("mailOutbound:getEffectByProviderMessage"),
  },
  gmailMailboxDisposition: {
    putCurrentState: mutationRef("gmailMailboxDisposition:putCurrentState"),
    getCurrentState: queryRef("gmailMailboxDisposition:getCurrentState"),
    recordSettledDelivery: mutationRef("gmailMailboxDisposition:recordSettledDelivery"),
    getSettledDelivery: queryRef("gmailMailboxDisposition:getSettledDelivery"),
    getEffect: queryRef("gmailMailboxDisposition:getEffect"),
    findOutstanding: queryRef("gmailMailboxDisposition:findOutstanding"),
    reserveEffect: mutationRef("gmailMailboxDisposition:reserveEffect"),
    markReconciliationRequired: mutationRef("gmailMailboxDisposition:markReconciliationRequired"),
    markSettled: mutationRef("gmailMailboxDisposition:markSettled"),
    releasePreconditionRetry: mutationRef("gmailMailboxDisposition:releasePreconditionRetry"),
  },
  workerEnrolments: {
    enrol: mutationRef("workerEnrolments:enrol"),
    heartbeat: mutationRef("workerEnrolments:heartbeat"),
    release: mutationRef("workerEnrolments:release"),
    get: mutationRef("workerEnrolments:get"),
    resolveCurrent: mutationRef("workerEnrolments:resolveCurrent"),
  },
  workSelectionClaims: {
    accept: mutationRef("workSelectionClaims:accept"),
  },
  callsignLeases: {
    reserve: mutationRef("callsignLeases:reserve"),
    renew: mutationRef("callsignLeases:renew"),
    release: mutationRef("callsignLeases:release"),
    get: mutationRef("callsignLeases:get"),
    getCurrent: mutationRef("callsignLeases:getCurrent"),
  },
  completionContinuations: {
    complete: mutationRef("completionContinuations:complete"),
  },
  claims: {
    acquire: mutationRef("claims:acquire"),
    renew: mutationRef("claims:renew"),
    release: mutationRef("claims:release"),
  },
  events: {
    record: mutationRef("events:record"),
    list: queryRef("events:list"),
  },
  operationReceipts: {
    get: queryRef("operationReceipts:get"),
  },
  artifacts: {
    attach: mutationRef("artifacts:attach"),
    list: queryRef("artifacts:list"),
  },
  continuations: {
    propose: mutationRef("continuations:propose"),
    get: mutationRef("continuations:get"),
    list: mutationRef("continuations:list"),
    resolve: mutationRef("continuations:resolve"),
    edit: mutationRef("continuationEdits:edit"),
  },
  continuationSupervisor: {
    queue: mutationRef("continuationSupervisor:queue"),
    runPolicy: mutationRef("continuationSupervisor:runPolicy"),
  },
  runs: {
    start: mutationRef("runs:start"),
    heartbeat: mutationRef("runs:heartbeat"),
    finish: mutationRef("runs:finish"),
    listActive: queryRef("runs:listActive"),
  },
  dependencies: {
    add: mutationRef("dependencies:add"),
    list: queryRef("dependencies:list"),
  },
  accounts: {
    upsertProviderIdentity: mutationRef("accounts:upsertProviderIdentity"),
    createSession: mutationRef("accounts:createSession"),
    authenticateSession: queryRef("accounts:authenticateSession"),
    touchSession: mutationRef("accounts:touchSession"),
    rotateSession: mutationRef("accounts:rotateSession"),
    revokeSession: mutationRef("accounts:revokeSession"),
    listSessions: queryRef("accounts:listSessions"),
    setDefaultActor: mutationRef("accounts:setDefaultActor"),
  },
  oauthStates: {
    create: mutationRef("oauthStates:create"),
    consume: mutationRef("oauthStates:consume"),
  },
  mcpOAuth: {
    registerClient: mutationRef("mcpOAuth:registerClient"),
    getClient: queryRef("mcpOAuth:getClient"),
    createAuthorizationCode: mutationRef("mcpOAuth:createAuthorizationCode"),
    exchangeAuthorizationCode: mutationRef("mcpOAuth:exchangeAuthorizationCode"),
    rotateRefreshToken: mutationRef("mcpOAuth:rotateRefreshToken"),
  },
  tokens: {
    register: mutationRef("tokens:register"),
    authenticate: queryRef("tokens:authenticate"),
    list: queryRef("tokens:list"),
    revoke: mutationRef("tokens:revoke"),
  },
  migration: {
    importProjectsActors: mutationRef("migration:importProjectsActors"),
    importItems: mutationRef("migration:importItems"),
    importEvents: mutationRef("migration:importEvents"),
    importArtifacts: mutationRef("migration:importArtifacts"),
    importTokens: mutationRef("migration:importTokens"),
  },
  reservations: {
    acquire: mutationRef("reservations:acquire"),
    release: mutationRef("reservations:release"),
    listActive: queryRef("reservations:listActive"),
  },
} as const;
