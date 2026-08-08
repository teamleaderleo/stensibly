import { HttpGitHubOAuthClient } from "../../src/hosted-auth.ts";
import { receiverSafeFetch } from "../../src/fetch-implementation.ts";
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

    if (path === "/receiver-safe-fetch") {
      const holder = { fetch: receiverSafeFetch() };
      const response = await holder.fetch(
        "https://receiver.test/receiver-ok",
      );
      return json({
        ok: response.ok,
        body: await response.text(),
        path: "receiverSafeFetch default fetch stored on an object",
      });
    }

    return json({ error: "not_found" }, 404);
  },
};
