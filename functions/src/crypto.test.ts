import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  sha256,
} from "./crypto.js";

describe("token crypto", () => {
  it("round-trips AES-GCM encrypted values", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptSecret("refresh-token", key);
    expect(encrypted.ciphertext).not.toContain("refresh-token");
    expect(decryptSecret(encrypted, key)).toBe("refresh-token");
  });

  it("hashes and compares stable values", () => {
    expect(sha256("token")).toBe(sha256("token"));
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different")).toBe(false);
  });
});
