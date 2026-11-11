// N1 PR B: IMAP provider presets for the newsletter inbox wizard.
//
// Pure data + helpers, safe to import from client components (no node APIs).
// The admin types an e-mail address; the domain picks a preset, which fills
// host/port/TLS and links to the provider's "app password" page. Unknown
// domains fall back to DNS autodiscovery in lib/inbound-email-poller.ts.

export type PlusAddressing = "yes" | "no" | "unverified";

export interface ImapPreset {
  id: string;
  label: string;
  /** Mailbox domains served by this provider (lowercase). */
  domains: readonly string[];
  host: string;
  port: number;
  /** Implicit TLS (993). STARTTLS presets are not used: every preset speaks IMAPS. */
  secure: true;
  /** Where the admin creates an app password (or the provider's IMAP help page). */
  appPasswordUrl: string;
  /** Does the provider deliver `local+tag@domain` to `local@domain`? */
  plusAddressing: PlusAddressing;
  /** Gmail ignores dots in the local part (`a.b@gmail.com` == `ab@gmail.com`). */
  ignoreLocalDots?: boolean;
  /** Provider needs IMAP switched on in its web settings first. */
  imapToggle?: boolean;
  /** Provider is known to refuse password/app-password IMAP logins for some accounts (OAuth only). */
  oauthOnlyRisk?: boolean;
  /**
   * authserv-id the provider's MX is EXPECTED to put on the topmost
   * Authentication-Results header (RFC 8601). Only a candidate: it is NOT
   * used for a verdict until the preset id is listed in
   * TRUSTED_AUTHSERV_VERIFIED_PRESETS — i.e. until a test mail carrying a
   * forged header with this id has shown that the provider strips/replaces
   * it (RFC 8601 §5). Unverified until test mail.
   */
  authservIdCandidate: string | null;
  /** Why the candidate is set / left empty (kept next to the data on purpose). */
  authservNote: string;
}

export const IMAP_PRESETS: readonly ImapPreset[] = [
  {
    id: "gmail",
    label: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    plusAddressing: "yes",
    ignoreLocalDots: true,
    imapToggle: false,
    // Gmail's MX prepends `Authentication-Results: mx.google.com; …` to every
    // inbound message; that id is documented in Google's header examples.
    authservIdCandidate: "mx.google.com",
    authservNote: "Gmail MX prepends `mx.google.com`; stripping of forged copies unverified until test mail.",
  },
  {
    id: "outlook",
    label: "Outlook / Hotmail",
    domains: ["outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "live.com", "live.de", "msn.com"],
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    appPasswordUrl: "https://account.live.com/proofs/AppPassword",
    plusAddressing: "yes",
    oauthOnlyRisk: true,
    // Exchange Online often writes Authentication-Results WITHOUT an
    // authserv-id (`spf=pass (sender IP is …)`), so there is no stable id to pin.
    authservIdCandidate: null,
    authservNote: "Exchange Online headers often carry no authserv-id; nothing stable to trust.",
  },
  {
    id: "icloud",
    label: "iCloud",
    domains: ["icloud.com", "me.com", "mac.com"],
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    appPasswordUrl: "https://account.apple.com/account/manage",
    plusAddressing: "yes",
    // iCloud splits results over several headers with different ids
    // (dkim/spf/dmarc verifiers), so "topmost header with one id" does not fit.
    authservIdCandidate: null,
    authservNote: "iCloud uses several Authentication-Results headers with different ids; not pinned.",
  },
  {
    id: "gmx",
    label: "GMX",
    domains: ["gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com"],
    host: "imap.gmx.net",
    port: 993,
    secure: true,
    appPasswordUrl: "https://hilfe.gmx.net/pop-imap/imap/index.html",
    plusAddressing: "unverified",
    imapToggle: true,
    authservIdCandidate: null,
    authservNote: "No documented authserv-id.",
  },
  {
    id: "webde",
    label: "WEB.DE",
    domains: ["web.de"],
    host: "imap.web.de",
    port: 993,
    secure: true,
    appPasswordUrl: "https://hilfe.web.de/pop-imap/imap/index.html",
    plusAddressing: "unverified",
    imapToggle: true,
    authservIdCandidate: null,
    authservNote: "No documented authserv-id.",
  },
  {
    id: "posteo",
    label: "Posteo",
    domains: ["posteo.de", "posteo.net", "posteo.org", "posteo.eu", "posteo.at", "posteo.ch", "posteo.us", "posteo.uk"],
    host: "posteo.de",
    port: 993,
    secure: true,
    appPasswordUrl: "https://posteo.de/hilfe/wie-richte-ich-mein-e-mail-programm-ein",
    plusAddressing: "yes",
    authservIdCandidate: null,
    authservNote: "No documented authserv-id.",
  },
  {
    id: "mailboxorg",
    label: "mailbox.org",
    domains: ["mailbox.org"],
    host: "imap.mailbox.org",
    port: 993,
    secure: true,
    appPasswordUrl: "https://kb.mailbox.org/de/privat/e-mail-artikel/app-passwoerter",
    plusAddressing: "yes",
    authservIdCandidate: null,
    authservNote: "No documented authserv-id.",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm", "fastmail.de", "fastmail.net", "fastmail.org", "fastmail.us", "messagingengine.com"],
    host: "imap.fastmail.com",
    port: 993,
    secure: true,
    appPasswordUrl: "https://app.fastmail.com/settings/security/apppasswords",
    plusAddressing: "yes",
    // Fastmail's authserv-id differs per MX host (mxN.messagingengine.com),
    // so a single pinned id would be wrong or need wildcards.
    authservIdCandidate: null,
    authservNote: "authserv-id varies per MX host; a single id cannot be pinned.",
  },
  {
    id: "yahoo",
    label: "Yahoo",
    domains: ["yahoo.com", "yahoo.de", "yahoo.co.uk", "yahoo.fr", "ymail.com", "rocketmail.com"],
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    appPasswordUrl: "https://login.yahoo.com/myaccount/security/app-password",
    // Yahoo offers "disposable addresses" instead of `+tag` subaddressing.
    plusAddressing: "no",
    authservIdCandidate: null,
    authservNote: "No documented authserv-id.",
  },
];

/**
 * Presets whose `authservIdCandidate` has been confirmed with a test mail
 * that carried a forged Authentication-Results header with the same id (the
 * provider must strip or bury it below its own). Empty on purpose: every
 * candidate is unverified until test mail, so newsletter auth stays `none`.
 * Extend this list only with such evidence.
 */
export const TRUSTED_AUTHSERV_VERIFIED_PRESETS: readonly string[] = [];

/** The authserv-id the ingest may trust for this preset, or null (verdict `none`). */
export function trustedAuthservIdForPreset(presetId: string | null | undefined): string | null {
  if (!presetId || !TRUSTED_AUTHSERV_VERIFIED_PRESETS.includes(presetId)) return null;
  return IMAP_PRESETS.find((p) => p.id === presetId)?.authservIdCandidate ?? null;
}

export function getImapPreset(id: string | null | undefined): ImapPreset | null {
  return IMAP_PRESETS.find((p) => p.id === id) ?? null;
}

const EMAIL_RE = /^[^\s@<>"',;:()[\]\\]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

/** Lowercased domain of a plausible mailbox address, or null. */
export function emailDomain(email: string): string | null {
  const m = EMAIL_RE.exec(email.trim());
  return m ? m[1].toLowerCase() : null;
}

export function isPlausibleMailbox(email: string): boolean {
  if (email.length > 254) return false;
  const domain = emailDomain(email);
  if (!domain) return false;
  // `+` in the base mailbox would collide with our own `+ff-` tag.
  return !email.slice(0, email.lastIndexOf("@")).includes("+");
}

export function detectImapPreset(email: string): ImapPreset | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  return IMAP_PRESETS.find((p) => p.domains.includes(domain)) ?? null;
}
