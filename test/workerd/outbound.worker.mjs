export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.hostname === "receiver.test") {
      return new Response("receiver-ok", { status: 200 });
    }

    if (
      url.hostname === "github.com"
      && url.pathname === "/login/oauth/access_token"
      && request.method === "GET"
    ) {
      return new Response("preflight reached local outbound mock", {
        status: 405,
        headers: { "x-stensibly-runtime-parity": "github-preflight" },
      });
    }

    return new Response("unexpected outbound request", { status: 502 });
  },
};
