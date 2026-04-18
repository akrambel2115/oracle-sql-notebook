import { describe, expect, it } from "vitest";

import { redactSensitive, toSafeErrorMessage } from "../../src/security/redaction";

describe("redaction", () => {
  it("redacts password-like key/value content", () => {
    const source = "password=supersecret";
    expect(redactSensitive(source)).toContain("password=<redacted>");
  });

  it("redacts URI credentials", () => {
    const source = "oracle://scott:tiger@localhost/XEPDB1";
    expect(redactSensitive(source)).toContain("oracle://scott:<redacted>@localhost/XEPDB1");
  });

  it("converts error to safe message", () => {
    const error = new Error("token: abc123");
    expect(toSafeErrorMessage(error)).not.toContain("abc123");
  });
});
