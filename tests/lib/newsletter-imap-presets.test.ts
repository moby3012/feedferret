import { describe, expect, it } from "vitest";
import {
  detectImapPreset,
  emailDomain,
  IMAP_PRESETS,
  isPlausibleMailbox,
  TRUSTED_AUTHSERV_VERIFIED_PRESETS,
  trustedAuthservIdForPreset,
} from "@/lib/newsletter-imap-presets";

describe("IMAP presets", () => {
  it.each([
    ["me@gmail.com", "gmail", "imap.gmail.com"],
    ["me@GoogleMail.com", "gmail", "imap.gmail.com"],
    ["me@hotmail.de", "outlook", "outlook.office365.com"],
    ["me@live.com", "outlook", "outlook.office365.com"],
    ["me@me.com", "icloud", "imap.mail.me.com"],
    ["me@gmx.net", "gmx", "imap.gmx.net"],
    ["me@web.de", "webde", "imap.web.de"],
    ["me@posteo.de", "posteo", "posteo.de"],
    ["me@mailbox.org", "mailboxorg", "imap.mailbox.org"],
    ["me@fastmail.com", "fastmail", "imap.fastmail.com"],
    ["me@yahoo.de", "yahoo", "imap.mail.yahoo.com"],
  ])("%s → %s", (email, id, host) => {
    const preset = detectImapPreset(email);
    expect(preset?.id).toBe(id);
    expect(preset?.host).toBe(host);
    expect(preset?.port).toBe(993);
    expect(preset?.appPasswordUrl).toMatch(/^https:\/\//);
  });

  it("returns null for unknown domains and junk", () => {
    expect(detectImapPreset("me@example.org")).toBeNull();
    expect(detectImapPreset("nope")).toBeNull();
    expect(emailDomain("A@Sub.Example.ORG")).toBe("sub.example.org");
  });

  it("rejects a base mailbox that already carries a + tag", () => {
    expect(isPlausibleMailbox("box@gmail.com")).toBe(true);
    expect(isPlausibleMailbox("box+x@gmail.com")).toBe(false);
    expect(isPlausibleMailbox("box@localhost")).toBe(false);
  });

  it("never trusts an authserv-id until a preset is verified by test mail", () => {
    expect(TRUSTED_AUTHSERV_VERIFIED_PRESETS).toEqual([]);
    for (const preset of IMAP_PRESETS) {
      expect(trustedAuthservIdForPreset(preset.id)).toBeNull();
      expect(preset.authservNote.length).toBeGreaterThan(0);
    }
    expect(IMAP_PRESETS.find((p) => p.id === "gmail")?.authservIdCandidate).toBe("mx.google.com");
  });

  it("flags providers without plus-addressing", () => {
    expect(detectImapPreset("x@yahoo.com")?.plusAddressing).toBe("no");
  });
});
