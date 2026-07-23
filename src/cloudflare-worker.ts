import { createHostedAppFromEnv } from "./hosted-app.js";

export interface CloudflareBindings extends Record<string, string | undefined> {
  CONVEX_URL: string;
  STENSIBLY_SERVICE_SECRET: string;
  STENSIBLY_WORKSPACE?: string;
  STENSIBLY_ALLOWED_ORIGINS?: string;
  STENSIBLY_ALLOWED_HOSTS?: string;
}

const worker = {
  async fetch(request: Request, env: CloudflareBindings): Promise<Response> {
    return await createHostedAppFromEnv(env).fetch(request);
  },
};

export default worker;
