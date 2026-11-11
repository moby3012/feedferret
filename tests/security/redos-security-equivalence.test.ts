import { describe, expect, it } from "vitest";
import { redact } from "@/lib/redact";
import { isSafeStyleValue, stripLayoutBreakingStyles } from "@/lib/sanitize-html";

// The ReDoS sweep replaced regexes inside two security filters with linear scanners:
//   (a) the inline-style value guard of the HTML sanitizer (`name(` detection, #263),
//   (b) the credential scrubber `redact` (secret params, encoded params, userinfo, confirm-email t=/c=; #262/#272).
// "No behaviour change" is a security claim there, so both are pinned against the ORIGINAL regex
// implementations (kept below verbatim as oracles) on hand-written vectors and a generated corpus.
// Equality is asserted (stronger than "rejects at least the same set"): a filter that suddenly
// accepts or masks differently fails the test.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function corpus(fragments: readonly string[], cases: number, maxParts: number, seed: number): string[] {
  const rand = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < cases; i++) {
    const n = 1 + Math.floor(rand() * maxParts);
    let s = "";
    for (let k = 0; k < n; k++) s += fragments[Math.floor(rand() * fragments.length)];
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- (a) CSS guard

const ALLOWED_CSS_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "calc", "min", "max", "clamp", "var"]);
const FORBIDDEN_VALUE_RE = /\\|\/\*|\*\/|[<>{}@]|!\s*important|javascript:|expression|behavior|-moz-binding/i;

/** Verbatim copy of the pre-sweep implementation (lib/sanitize-html.ts on main before this PR). */
function legacyIsSafeStyleValue(value: string): boolean {
  if (!value || FORBIDDEN_VALUE_RE.test(value)) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  for (const match of value.matchAll(/([a-z0-9_-]*)\s*\(/gi)) {
    if (!ALLOWED_CSS_FUNCTIONS.has(match[1].toLowerCase())) return false;
  }
  return true;
}

const CSS_ATTACKS = [
  "url(https://evil.test/x.png)", "URL(x)", "Url (x)", "url\t(x)", "url (x)", "u\rl(x)", "u\nrl(x)", "ur\u0000l(x)", "u\u2028rl(x)", "u\u2029rl(x)",
  "\\75 rl(x)", "\\000075rl(x)", "ur\\6c(x)", "\\75rl(x)", "u/**/rl(x)", "/**/url(x)", "url(x)/**/", "url/**/(x)",
  "image-set(x 1x)", "-webkit-image-set(x 1x)", "IMAGE-SET (x 1x)", "cross-fade(x, y, 50%)", "element(#id)", "attr(data-x)", "env(safe-area-inset-top)",
  "expression(alert(1))", "EXPRESSION (alert(1))", "red !important", "red ! important", "red!IMPORTANT", "red !\timportant",
  "javascript:alert(1)", "behavior:url(x)", "-moz-binding:url(x)", "red; background:url(x)", "red}body{x:y", "<script>", "@import 'x'",
  "calc(1px + url(x))", "rgb(url(x))", "var(--a, url(x))", "((url(x)))", "min(1px, expression(1))", "a(b(c(url(x))))",
  "x\u0085url(x)", "x\u00a0url(x)", "url\u00a0(x)", "url\u2003(x)", "url\ufeff(x)",
];
const CSS_SAFE = [
  "red", "10px", "rgb(1,2,3)", "RGB (1, 2, 3)", "rgba(0 0 0 / 50%)", "hsl(120deg 50% 50%)", "calc(100% - 2px)", "min(1px, 2px)", "max(1px,2px)", "clamp(1px, 2vw, 3px)",
  "var(--x)", "var(--x, 4px)", "calc(var(--a) * 2)", "bold", "1px solid red", "Arial, sans-serif", "0 0 1px rgb(0,0,0)",
];
const CSS_FRAGMENTS = [
  "url(", "URL (", "u\rl(", "\\75 rl(", "/**/", "image-set(", "expression(", "!important", "! important", "\\", "\n", "\r", "\t", "\u0000", "\u2028", "\u2029", "\u0085", "\u00a0",
  "(", ")", "rgb(", "RGB(", "calc(", "var(", "min(", "clamp(", "hsl (", " ", "  ", "a", "x", "-", "_", "red", "1px", ",", ";", ":", "{", "}", "<", ">", "@", "javascript:",
  "behavior", "-moz-binding", "element(", "attr(", "env(", "cross-fade(", "u", "rl", "ur", "l", "0", "9", "%", "#fff", "!", "important", "é", "ſ", "K",
];

describe("sanitizer CSS value guard: new scanner ≡ original regex implementation", () => {
  it("rejects every hand-written attack vector, as the original did", () => {
    for (const v of CSS_ATTACKS) {
      expect(legacyIsSafeStyleValue(v), `legacy should reject ${JSON.stringify(v)}`).toBe(false);
      expect(isSafeStyleValue(v), `new should reject ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("accepts the same legitimate values", () => {
    for (const v of CSS_SAFE) {
      expect(legacyIsSafeStyleValue(v)).toBe(true);
      expect(isSafeStyleValue(v)).toBe(true);
    }
  });

  it("agrees on a generated corpus (both accept and reject sets identical)", () => {
    let safe = 0;
    let unsafe = 0;
    for (const v of [...CSS_ATTACKS, ...CSS_SAFE, ...corpus(CSS_FRAGMENTS, 30_000, 10, 11)]) {
      const expected = legacyIsSafeStyleValue(v);
      if (expected) safe++;
      else unsafe++;
      expect(isSafeStyleValue(v), JSON.stringify(v)).toBe(expected);
    }
    expect(safe).toBeGreaterThan(300);
    expect(unsafe).toBeGreaterThan(300);
  });

  it("end to end: attack values never survive in a style attribute", () => {
    for (const v of CSS_ATTACKS) {
      const out = stripLayoutBreakingStyles(`color: ${v}; width: 10px`);
      expect(out.toLowerCase(), JSON.stringify(v)).not.toMatch(/url|image-set|expression|javascript|binding|behavior/);
    }
  });
});

// ------------------------------------------------------------------ (b) redact

/** Verbatim copy of the pre-sweep implementation (lib/redact.ts on main before this PR). */
function legacyRedact(text: string): string {
  return text
    .replace(/\/account\/confirm-email\?[^\s"'<>#]*/gi, (url) => url.replace(/((?:\?|&amp;|&)(?:t|c)=)[^&#\s"']*/gi, "$1***"))
    .replace(/(?:%2f|\/)account(?:%2f|\/)confirm-email%3f(?:(?!%23)[^\s"'<>#])*/gi, (url) => url.replace(/((?:%3f|%26)(?:t|c)%3d)(?:(?!%26|%23)[^&#\s"'])*/gi, "$1***"))
    .replace(/((?:[?&#;]|&amp;)[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|sig(?:nature)?)=)[^&#\s"']*/gi, "$1***")
    .replace(/((?:%3f|%26|%23|%3b)(?:[\w.-]|%[0-9a-f]{2})*?(?:key|token|secret|passw(?:or)?d|pwd|auth|sig(?:nature)?)%3d)(?:(?!%26|%23|%3b)[^&#\s"'])*/gi, "$1***")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, "$1***@");
}

const SECRET_NAMES = ["key", "api_key", "apikey", "token", "access_token", "refresh-token", "secret", "client_secret", "password", "passwd", "pwd", "auth", "sig", "signature", "X-Amz-Signature"];
// t / c are only secrets inside confirm-email links; "authorization" is deliberately NOT masked by the original either (the keyword must end the name) — equality still covers it.
const NAMES = [...SECRET_NAMES, "authorization", "t", "c"];
const REDACT_TABLE = [
  // plain query / fragment / matrix params
  ...NAMES.flatMap((n) => [`https://h.test/p?${n}=SECRET123&x=1`, `https://h.test/p?a=1&${n}=SECRET123#frag`, `https://h.test/p#${n}=SECRET123`, `https://h.test/p;${n}=SECRET123;z=1`, `https://h.test/p?${n.toUpperCase()}=SECRET123`, `https://h.test/p?a=1&amp;${n}=SECRET123&amp;b=2`]),
  // percent-encoded query strings
  ...NAMES.flatMap((n) => [`https://h.test/p%3F${n}%3DSECRET123%26x%3D1`, `https://h.test/p%3Fa%3D1%26${n}%3DSECRET123%23frag`, `x%3B${n}%3DSECRET123%3Bz%3D1`, `https://h.test/p%3F${n.toUpperCase()}%3DSECRET`, `%3Fprefix_${n}%3Dv`, `%26a.b-c_${n}%3Dv`]),
  // confirm-email links (plain, encoded, mixed-case)
  "GET /account/confirm-email?t=TOK&c=COD HTTP/1.1", "https://h.test/account/confirm-email?c=COD&t=TOK#x", "https://h.test/account/confirm-email?foo=1&amp;t=TOK&amp;c=COD",
  "https://h.test/ACCOUNT/Confirm-Email?T=TOK", "https://h.test%2Faccount%2Fconfirm-email%3Ft%3DTOK%26c%3DCOD", "https://h.test/account%2Fconfirm-email%3Ft%3DTOK%23x",
  "%2Faccount%2Fconfirm-email%3Fc%3DCOD", "next=%2Faccount%2Fconfirm-email%3Ft%3DTOK%26c%3DCOD&other=1", "/account/confirm-email?t=TOK\"quoted\"",
  // userinfo
  "https://user:pass@host.test/x", "ftp://u@h/", "postgres://app:s3cr3t@db:5432/ff", "git+ssh://git@github.com/x/y.git", "see http://a:b@h and https://c:d@i", "HTTPS://U:P@H/", "x-y.z+w://u:p@h",
  "no creds https://host.test/path@notuserinfo", "https://host/p?u=a@b.test", "scheme://@host", "://u:p@h", "1http://u:p@h", "a://b://c@d",
  // untouched text
  "plain text without secrets", "", "token without equals", "https://h.test/?tokens=1", "a=b&c=d",
];
const REDACT_FRAGMENTS = [
  "?", "&", "&amp;", "#", ";", "%3F", "%3f", "%26", "%23", "%3B", "%3b", "%3D", "%3d", "=", "key", "api_key", "token", "secret", "password", "passwd", "pwd", "auth", "sig", "signature",
  "t", "c", "_", "-", ".", "x", "0", "%2F", "%2f", "/account/confirm-email", "%2Faccount%2Fconfirm-email", "account", "confirm-email", "https://", "http://", "ftp://", "a://", "://", "user:pw@", "u@", "@", ":",
  "host", "/", " ", "\n", '"', "'", "<", ">", "a", "Z", "%2a", "%zz", "%", "+", "SECRET",
];

describe("redact: new implementation ≡ original regex implementation", () => {
  it("redacts the hand-written secret table identically (and actually masks)", () => {
    let masked = 0;
    for (const v of REDACT_TABLE) {
      const expected = legacyRedact(v);
      if (expected !== v) masked++;
      expect(redact(v), JSON.stringify(v)).toBe(expected);
    }
    expect(masked).toBeGreaterThan(150);
  });

  it("really masks the secret-named params (plain and encoded) and userinfo", () => {
    for (const n of SECRET_NAMES) {
      for (const v of [`https://h.test/p?${n}=SECRET123&x=1`, `https://h.test/p%3F${n}%3DSECRET123%26x%3D1`, `https://h.test/p#${n}=SECRET123`]) {
        expect(redact(v), v).not.toContain("SECRET123");
        expect(legacyRedact(v), v).not.toContain("SECRET123");
      }
    }
    for (const v of ["https://user:pass@host.test/x", "postgres://app:s3cr3t@db:5432/ff"]) {
      expect(redact(v)).not.toMatch(/pass@|s3cr3t/);
    }
    expect(redact("https://h.test/account/confirm-email?t=TOK&c=COD")).not.toMatch(/TOK|COD/);
    expect(redact("https://h.test%2Faccount%2Fconfirm-email%3Ft%3DTOK%26c%3DCOD")).not.toMatch(/TOK|COD/);
  });

  it("redacts a generated corpus identically", () => {
    let masked = 0;
    for (const v of corpus(REDACT_FRAGMENTS, 60_000, 18, 5)) {
      const expected = legacyRedact(v);
      if (expected !== v) masked++;
      expect(redact(v), JSON.stringify(v)).toBe(expected);
    }
    expect(masked).toBeGreaterThan(2_000);
  });

  it("redacts secrets embedded in longer realistic log lines identically", () => {
    const lines = REDACT_TABLE.map((v, i) => `[2026-01-01T00:00:0${i % 10}Z] fetch failed for "${v}" (status 502) — retrying; ctx=${v}`);
    for (const l of lines) expect(redact(l)).toBe(legacyRedact(l));
  });
});
