import { describe, expect, it } from "vitest";
import {
  RENEW_LEAD_MS,
  advanceChangeCursor,
  isNewerMessage,
  needsRenewal,
} from "./watch-policy.js";

describe("change cursor", () => {
  it("follows the next page and then commits the start token", () => {
    expect(advanceChangeCursor("100", { nextPageToken: "140" })).toEqual({
      pageToken: "140",
      done: false,
    });
    expect(advanceChangeCursor("140", { newStartPageToken: "180" })).toEqual({
      pageToken: "180",
      done: true,
    });
  });

  it("keeps the current token when Drive returns an empty page", () => {
    expect(advanceChangeCursor("180", {})).toEqual({
      pageToken: "180",
      done: true,
    });
  });
});

describe("webhook idempotency", () => {
  it("accepts only a higher Google message number", () => {
    expect(isNewerMessage("4", "5")).toBe(true);
    expect(isNewerMessage("5", "5")).toBe(false);
    expect(isNewerMessage("9", "8")).toBe(false);
  });
});

describe("channel renewal", () => {
  it("renews inside the lead window and keeps younger channels", () => {
    const now = Date.parse("2026-10-13T00:00:00Z");
    expect(needsRenewal(now + RENEW_LEAD_MS, now)).toBe(true);
    expect(needsRenewal(now + RENEW_LEAD_MS + 1, now)).toBe(false);
  });
});
