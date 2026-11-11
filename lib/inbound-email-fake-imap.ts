// N1 PR B: test-only fake IMAP mailbox for the e2e harness (no network).
//
// Gate (same as the fake AI provider, lib/ai/fake.ts): FEEDFERRET_FAKE_IMAP=1
// AND either a non-production NODE_ENV or the per-run e2e harness token that
// matches the marker next to the freshly seeded SQLite DB. A real deployment
// with the flag set by mistake has no marker, so the fake stays off.
//
// The mailbox is a spool directory next to the e2e DB (`<db>.imap-spool/`):
// `INBOX/<uid>.eml` are the messages; MOVE renames into `<folder>/`. The e2e
// spec drops .eml files there to "deliver" mail.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isE2eHarness } from "@/lib/ai/fake";
import type { ImapClientFactory, ImapClientLike, LookupFn } from "@/lib/inbound-email-poller";

/** The only password the fake accepts; "e2e-normal-password" simulates Gmail's app-password refusal. */
export const FAKE_IMAP_PASSWORD = "e2e-app-pass";

export function isFakeImapEnabled(): boolean {
  if (process.env.FEEDFERRET_FAKE_IMAP !== "1") return false;
  if (process.env.NODE_ENV !== "production") return true;
  return isE2eHarness();
}

export function fakeImapSpoolDir(): string | null {
  const kind = (process.env.DATABASE_PROVIDER || "sqlite").toLowerCase();
  const m = /^file:([^?]+)/.exec(process.env.DATABASE_URL ?? "");
  if ((kind !== "sqlite" && kind !== "file") || !m) return null;
  return `${resolve(/*turbopackIgnore: true*/ m[1])}.imap-spool`;
}

function uidsIn(dir: string): number[] {
  try {
    return readdirSync(/*turbopackIgnore: true*/ dir)
      .map((f) => /^(\d+)\.eml$/.exec(f)?.[1])
      .filter((v): v is string => !!v)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function fakeClient(spool: string, pass: string): ImapClientLike {
  let folder = "INBOX";
  const file = (uid: number) => join(/*turbopackIgnore: true*/ spool, folder, `${uid}.eml`);
  const ensure = (path: string) => mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ spool, path), { recursive: true });
  return {
    async connect() {
      if (pass === "e2e-normal-password") {
        throw Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "[ALERT] Application-specific password required" });
      }
      if (pass !== FAKE_IMAP_PASSWORD) {
        throw Object.assign(new Error("Command failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED", responseText: "Invalid credentials" });
      }
      ensure("INBOX");
    },
    async list() {
      return readdirSync(/*turbopackIgnore: true*/ spool, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ path: d.name }));
    },
    async getMailboxLock(path: string) {
      folder = path;
      ensure(path);
      return { release() {} };
    },
    async search() {
      return uidsIn(join(/*turbopackIgnore: true*/ spool, folder));
    },
    fetch(range) {
      const wanted = new Set(Array.isArray(range) ? range : []);
      return (async function* () {
        for (const uid of uidsIn(join(/*turbopackIgnore: true*/ spool, folder))) {
          if (!wanted.has(uid)) continue;
          const raw = readFileSync(/*turbopackIgnore: true*/ file(uid));
          yield { uid, flags: new Set<string>(), size: statSync(/*turbopackIgnore: true*/ file(uid)).size, headers: Buffer.from(raw.toString("utf8").split(/\r?\n\r?\n/)[0]) };
        }
      })();
    },
    async fetchOne(range: string) {
      const uid = Number(range);
      try {
        return { uid, source: readFileSync(/*turbopackIgnore: true*/ file(uid)) };
      } catch {
        return false;
      }
    },
    async mailboxCreate(path: string) {
      ensure(path);
      return { path };
    },
    async messageMove(range, destination: string) {
      ensure(destination);
      for (const uid of Array.isArray(range) ? range : []) {
        renameSync(/*turbopackIgnore: true*/ file(uid), join(/*turbopackIgnore: true*/ spool, destination, `${uid}.eml`));
      }
      return true;
    },
    async messageFlagsAdd() {
      return true;
    },
    async logout() {},
    close() {},
  };
}

/** Injected into the poller when the gate is open: no DNS, no sockets. */
export function fakeImapDeps(): { clientFactory: ImapClientFactory; lookup: LookupFn } | null {
  const spool = fakeImapSpoolDir();
  if (!spool) return null;
  mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ spool, "INBOX"), { recursive: true });
  return {
    clientFactory: (options) => fakeClient(spool, String((options.auth as { pass?: string } | undefined)?.pass ?? "")),
    // A public documentation-free address; never connected to.
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  };
}
