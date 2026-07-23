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
  reservations: {
    acquire: mutationRef("reservations:acquire"),
    release: mutationRef("reservations:release"),
    listActive: queryRef("reservations:listActive"),
  },
} as const;
