import { describe, expect, test } from "bun:test";
import {
  createMailPublicHandle,
  createMailPublicHandleAliasRecord,
  freezeMailPublicHandleAliasRecord,
  parseMailProjectCode,
  parseMailPublicHandle,
  resolveMailPublicHandle,
} from "../src/mail-public-handle.ts";

describe("project-owned public mail handles", () => {
  test("renders a Quarry-owned public code from the stable internal thread handle", () => {
    expect(createMailPublicHandle("qry", "STN-HANDOFF:Q7R4")).toBe(
      "QRY-HANDOFF:Q7R4",
    );
    expect(parseMailProjectCode("qry")).toBe("QRY");
    expect(parseMailPublicHandle("qry-handoff:q7r4")).toBe("QRY-HANDOFF:Q7R4");
  });

  test("binds preferred and legacy codes to one internal continuation", () => {
    const record = createMailPublicHandleAliasRecord({
      threadId: "mail_thread_quarry_q7r4",
      project: "quarry",
      projectCode: "QRY",
      internalHandle: "STN-HANDOFF:Q7R4",
    });

    expect(record.preferredPublicHandle).toBe("QRY-HANDOFF:Q7R4");
    expect(record.legacyPublicHandles).toEqual(["STN-HANDOFF:Q7R4"]);
    expect(resolveMailPublicHandle(record, "QRY-HANDOFF:Q7R4")).toBe(
      "STN-HANDOFF:Q7R4",
    );
    expect(resolveMailPublicHandle(record, "stn-handoff:q7r4")).toBe(
      "STN-HANDOFF:Q7R4",
    );
    expect(resolveMailPublicHandle(record, "ABC-HANDOFF:Q7R4")).toBeNull();
  });

  test("keeps aliases on the same class and token and rejects confusing project codes", () => {
    expect(() => createMailPublicHandleAliasRecord({
      threadId: "mail_thread_quarry_q7r4",
      project: "quarry",
      projectCode: "QRY",
      internalHandle: "STN-HANDOFF:Q7R4",
      legacyPublicHandles: ["OLD-REVIEW:Q7R4"],
    })).toThrow("same continuation token and class");

    expect(() => createMailPublicHandleAliasRecord({
      threadId: "mail_thread_quarry_q7r4",
      project: "quarry",
      projectCode: "QRY",
      internalHandle: "STN-HANDOFF:Q7R4",
      legacyPublicHandles: ["OLD-HANDOFF:7K3Q"],
    })).toThrow("same continuation token and class");

    expect(() => parseMailProjectCode("Q0I")).toThrow("Mail project code is invalid");
    expect(() => parseMailProjectCode("A")).toThrow("Mail project code is invalid");
  });

  test("is deterministic and deduplicates the preferred alias from legacy input", () => {
    const first = createMailPublicHandleAliasRecord({
      threadId: "mail_thread_quarry_q7r4",
      project: "quarry",
      projectCode: "QRY",
      internalHandle: "STN-HANDOFF:Q7R4",
      legacyPublicHandles: [
        "STN-HANDOFF:Q7R4",
        "QRY-HANDOFF:Q7R4",
        "STN-HANDOFF:Q7R4",
      ],
    });
    const second = freezeMailPublicHandleAliasRecord(first);

    expect(second).toEqual(first);
    expect(first.legacyPublicHandles).toEqual(["STN-HANDOFF:Q7R4"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.legacyPublicHandles)).toBe(true);
  });
});
