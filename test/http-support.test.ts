import { describe, expect, test } from "bun:test";
import { bearerJsonHeaders, jsonHeaders } from "./support/http.ts";

describe("HTTP test support", () => {
  test("keeps canonical JSON and bearer headers authoritative across casing", () => {
    expect(jsonHeaders({
      "content-type": "text/plain",
      "Content-Type": "application/xml",
      "x-test": "kept",
    })).toEqual({
      "content-type": "application/json",
      "x-test": "kept",
    });

    expect(bearerJsonHeaders("secret-token", {
      authorization: "Basic ignored",
      Authorization: "Bearer also-ignored",
      "CONTENT-TYPE": "text/plain",
      "idempotency-key": "request-1",
    })).toEqual({
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "request-1",
    });
  });
});
