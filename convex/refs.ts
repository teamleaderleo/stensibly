import { makeFunctionReference } from "convex/server";

const queryRef = (name: string) => makeFunctionReference<"query">(name);
const mutationRef = (name: string) => makeFunctionReference<"mutation">(name);

export const convexApi = {
  projects: {
    list: queryRef("projects:list"),
    brief: queryRef("projects:brief"),
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
  itemReservations: {
    list: queryRef("itemReservations:list"),
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
