import { describe, expect, test } from "bun:test";
import { bearerJsonHeaders, jsonHeaders } from "./support/http.ts";

describe("HTTP test support", () => {
  test("keeps canonical JSON and bearer headers authoritative", () => {
    expect(jsonHeaders({
      "Content-Type": "text/plain",
      "x-test": "retained",
    })).toEqual({
      "content-type": "application/json",
      "x-test": "retained",
    });
    expect(bearerJsonHeaders("secret-token", {
      Authorization: "Basic ignored",
      "CONTENT-TYPE": "text/plain",
      "idempotency-key": "request-1",
    })).toEqual({
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "idempotency-key": "request-1",
    });
  });
});
