import { HttpGitHubOAuthClient } from "../../src/hosted-auth.ts";
import {
  assertFetchReceiverProfile,
  assertWorkerdSelfFetchReceiverMatrix,
  runFetchReceiverMatrix,
  runSelfFetchReceiverMatrix,
} from "../runtime/fetch-receiver-matrix.mjs";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === "/health") {
      return new Response("ok");
    }

    if (path === "/matrix") {
      const results = await runFetchReceiverMatrix(
        "https://receiver.test/receiver-ok",
      );
      assertFetchReceiverProfile(results, "web-idl");
      return json({ runtime: "workerd", profile: "web-idl", results });
    }

    if (path === "/self-matrix") {
      const results = await runSelfFetchReceiverMatrix(
        "https://receiver.test/receiver-ok",
      );
      assertWorkerdSelfFetchReceiverMatrix(results);
      return json({
        runtime: "workerd",
        source: "const fromSelf = self.fetch",
        results,
      });
    }

    if (path === "/client") {
      const client = new HttpGitHubOAuthClient({
        clientId: "runtime-parity-client",
        clientSecret: "runtime-parity-secret",
      });
      await client.prepareExchange();
      return json({
        ok: true,
        path: "HttpGitHubOAuthClient default fetch",
      });
    }

    return json({ error: "not_found" }, 404);
  },
};
