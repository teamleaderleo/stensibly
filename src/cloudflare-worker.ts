import { createHostedAppFromEnv } from "./hosted-app.js";
import { observeWorkerRequest } from "./worker-observability.js";

export interface CloudflareBindings extends Record<string, string | undefined> {
  CONVEX_URL: string;
  STENSIBLY_SERVICE_SECRET: string;
  STENSIBLY_WORKSPACE?: string;
  STENSIBLY_ALLOWED_ORIGINS?: string;
  STENSIBLY_ALLOWED_HOSTS?: string;
}

const worker = {
  async fetch(request: Request, env: CloudflareBindings): Promise<Response> {
    return await observeWorkerRequest(
      request,
      async (observedRequest) =>
        await createHostedAppFromEnv(env).fetch(observedRequest),
      { allowedOrigins: splitList(env.STENSIBLY_ALLOWED_ORIGINS) },
    );
  },
};

export default worker;

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
