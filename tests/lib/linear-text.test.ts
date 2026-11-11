import { describe, expect, it } from "vitest";
import {
  collapseNewlineWhitespace,
  cssFunctionNames,
  replaceComments,
  stripFragment,
  replaceEmailAddresses,
  findLastPaddedSeparator,
  findRoleMainTag,
  firstImgSrc,
  isAddressRun,
  iterElementInners,
  iterOpenTags,
  looksLikeEmail,
  matchAddressRuns,
  matchAddressRunsLoose,
  matchOpenTags,
  redactEncodedParamValues,
  replaceTagsNamed,
  redactUrlUserinfo,
  removeSpaceBeforePunctuation,
  replaceElements,
  replaceMarkdownLinks,
  replaceSchemeUrls,
  stripTags,
  stripTagsNonEmpty,
  trimEndChars,
  trimTrailingSlashes,
} from "@/lib/linear-text";

// Each helper replaces a backtracking regex that was super-linear on hostile
// input. These tests keep them honest: on thousands of short random strings
// built from the fragments that make the old regexes interesting, helper and
// legacy regex must agree exactly. (The timing side lives in
// tests/security/redos-regression.test.ts.)

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function gen(fragments: readonly string[], cases = 3000, maxParts = 14, seed = 1): string[] {
  const rand = rng(seed);
  const out: string[] = [""];
  for (let i = 0; i < cases; i++) {
    const n = Math.floor(rand() * maxParts);
    let s = "";
    for (let k = 0; k < n; k++) s += fragments[Math.floor(rand() * fragments.length)];
    out.push(s);
  }
  return out;
}

const HTML_FRAGS = [
  "<", ">", "<a", "<a ", "<A ", "<p>", "</p>", "</P>", "<img", "<IMG ", " src=", "src=", "'", '"', "x.png", " ", "\n", "a", "1", "_",
  "<style", "<STYLE>", "</style>", "</style >", "</STYLE>", "<script>", "</script>", "<scripty>", "</scripty>", "<svg", "</svg>", "<template>", "</template>",
  "<noscript>", "</noscript>", "<link ", "<link", "<linkx>", "<head>", "</head>", "<meta", "role=main", ' role = "main"', "<div ", "<h1 ", "/", "=", "-",
];

describe("tag helpers match their legacy regexes", () => {
  const inputs = gen(HTML_FRAGS);

  it("stripTags / stripTagsNonEmpty", () => {
    for (const s of inputs) {
      expect(stripTags(s, " ")).toBe(s.replace(/<[^>]*>/g, " "));
      expect(stripTags(s, "")).toBe(s.replace(/<[^>]*>/g, ""));
      expect(stripTagsNonEmpty(s, " ")).toBe(s.replace(/<[^>]+>/g, " "));
    }
  });

  it("matchOpenTags / iterOpenTags", () => {
    for (const s of inputs) {
      for (const name of ["link", "a", "meta", "p"]) {
        expect(matchOpenTags(s, name)).toEqual(s.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? []);
      }
      expect(matchOpenTags(s, "img", false)).toEqual(s.match(/<img[^>]*>/gi) ?? []);
      const legacy = [...s.matchAll(/<a\b[^>]*>/gi)].map((m) => [m.index, m.index! + m[0].length]);
      expect([...iterOpenTags(s, "a")].map((t) => [t.start, t.end])).toEqual(legacy);
    }
  });

  it("replaceElements (style / noisy tags / title-synthesis forms)", () => {
    for (const s of inputs) {
      expect(replaceElements(s, ["style"], "")).toBe(s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ""));
      expect(replaceElements(s, ["script", "style"], " ", { boundary: false })).toBe(
        s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " "),
      );
      expect(replaceElements(s, ["script", "style", "svg", "noscript", "template"], " ")).toBe(
        s.replace(/<(script|style|svg|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " "),
      );
      expect(replaceElements(s, ["script", "style", "template", "noscript"], " ", { closeTagWhitespace: true, unclosedToEnd: true })).toBe(
        s.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " "),
      );
    }
  });

  it("replaceTagsNamed", () => {
    const names = new Set(["p", "div", "li", "pre", "h1", "h6", "figcaption"]);
    const re = /<\/?(?:p|div|li|pre|h[16]|figcaption)\b[^>]*>/gi;
    const frags = [...HTML_FRAGS, "<pre>", "</div>", "<h1>", "<h2>", "<figcaption ", "</li>", "<px>", "<p_>"];
    for (const s of gen(frags, 4000)) expect(replaceTagsNamed(s, names, " ")).toBe(s.replace(re, " "));
  });

  it("iterElementInners", () => {
    for (const s of inputs) {
      for (const name of ["a", "p"]) {
        const legacy = [...s.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "gi"))].map((m) => m[1]);
        expect([...iterElementInners(s, name)]).toEqual(legacy);
      }
    }
  });

  it("findRoleMainTag", () => {
    let hits = 0;
    for (const s of inputs) {
      const expected = s.search(/<[a-z]+\b[^>]*\brole\s*=\s*["']?main\b/i);
      if (expected >= 0) hits++;
      expect(findRoleMainTag(s)).toBe(expected);
    }
    expect(hits).toBeGreaterThan(20);
  });

  it("firstImgSrc", () => {
    let hits = 0;
    const imgFrags = ["<img", "<IMG", " ", " src=", "SRC=", '"', "'", "x", "a.png", ">", "<", "alt=", "\n"];
    for (const s of [...inputs, ...gen(imgFrags, 6000, 12, 7)]) {
      const expected = s.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? null;
      if (expected !== null) hits++;
      expect(firstImgSrc(s)).toBe(expected);
    }
    expect(hits).toBeGreaterThan(20);
    expect(firstImgSrc('<p><img alt="x" src="https://e.test/a.png"></p>')).toBe("https://e.test/a.png");
    expect(firstImgSrc("<IMG SRC='/b.jpg' >")).toBe("/b.jpg");
    expect(firstImgSrc("<img>")).toBeNull();
  });
});

describe("text helpers match their legacy regexes", () => {
  it("trailing runs", () => {
    const frags = ["/", "//", "a", " ", ">", ".", "=", "?", "!", "→", "-", "\n", "x"];
    for (const s of gen(frags)) {
      expect(trimTrailingSlashes(s)).toBe(s.replace(/\/+$/, ""));
      expect(trimEndChars(s, ">")).toBe(s.replace(/>+$/, ""));
      expect(trimEndChars(s, "=")).toBe(s.replace(/=+$/g, ""));
      expect(trimEndChars(s.replace(/\s/g, "_"), ">.")).toBe(s.replace(/\s/g, "_").replace(/[>.]+$/, ""));
    }
  });

  it("address runs", () => {
    const frags = ["a", "@", "b.c", " ", "<", ">", '"', ",", ";", ":", "(", ")", "[", "]", "'", "\n", "+ff-x", "=?", "x@y"];
    for (const s of gen(frags)) {
      expect(matchAddressRuns(s)).toEqual(s.match(/[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+/g) ?? []);
      expect(matchAddressRunsLoose(s)).toEqual(s.match(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g) ?? []);
      expect(looksLikeEmail(s)).toBe(/[^\s@]+@[^\s@]+\.[^\s@]+/.test(s));
    }
    expect(isAddressRun("a@b")).toBe(true);
    expect(isAddressRun("@ab")).toBe(false);
  });

  it("markdown links", () => {
    const frags = ["[", "]", "(", ")", "!", "a", " ", "![", "](", "x", "\n"];
    for (const s of gen(frags, 4000)) {
      expect(replaceMarkdownLinks(s, true, () => " ")).toBe(s.replace(/!\[[^\]]*\]\([^)]*\)/g, " "));
      expect(replaceMarkdownLinks(s, false, (t) => t)).toBe(s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    }
  });

  it("scheme URLs", () => {
    const frags = ["http", "://", "a", "1", "-", ".", "+", " ", "_", "x/y", "\n", "HTTPS", ":", "/", "é"];
    let replaced = 0;
    for (const s of gen(frags, 4000)) {
      const expected = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
      if (expected !== s) replaced++;
      expect(replaceSchemeUrls(s, " ")).toBe(expected);
    }
    expect(replaced).toBeGreaterThan(100);
  });

  it("log redaction", () => {
    const enc = ["%3F", "%26", "%23", "%3b", "%3D", "%2a", "api", "key", "token", "_", "a", "x", "=", "&", "#", " ", '"', "%", "sig", "nature", "%zz", "auth", "-", "."];
    const legacyEnc = /((?:%3f|%26|%23|%3b)(?:[\w.-]|%[0-9a-f]{2})*?(?:key|token|secret|passw(?:or)?d|pwd|auth|sig(?:nature)?)%3d)(?:(?!%26|%23|%3b)[^&#\s"'])*/gi;
    let changed = 0;
    for (const s of gen(enc, 6000, 16)) {
      const expected = s.replace(legacyEnc, "$1***");
      if (expected !== s) changed++;
      expect(redactEncodedParamValues(s)).toBe(expected);
    }
    expect(changed).toBeGreaterThan(50); // the generator must actually hit the redaction path
    const auth = ["http", "://", "a", "1", "-", "@", ":", "/", "?", "#", " ", "u", "p", "+", ".", "S3"];
    let maskedUrls = 0;
    for (const s of gen(auth, 6000, 14)) {
      const expected = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, "$1***@");
      if (expected !== s) maskedUrls++;
      expect(redactUrlUserinfo(s)).toBe(expected);
    }
    expect(maskedUrls).toBeGreaterThan(20);
  });

  it("whitespace helpers", () => {
    const frags = ["a", " ", "\n", "\r\n", "\t", ".", ",", "!", "?", ";", ":", " ", "b"];
    for (const s of gen(frags)) {
      expect(removeSpaceBeforePunctuation(s)).toBe(s.replace(/\s+([.,;:!?])/g, "$1"));
      expect(collapseNewlineWhitespace(s)).toBe(s.replace(/\s*\n\s*/g, " "));
    }
  });

  it("padded separator", () => {
    const frags = ["a", " ", "-", "|", "–", "—", "·", ":", "b", "  ", "x y"];
    const re = /\s+[-|–—·:]\s+(?=[^-|–—·:]*$)/;
    for (const s of gen(frags)) {
      const m = re.exec(s);
      const r = findLastPaddedSeparator(s);
      if (!m) expect(r).toBeNull();
      else expect(r).toEqual({ index: m.index, length: m[0].length });
    }
  });

  it("css function names", () => {
    const frags = ["rgb", "(", ")", " ", "-", "_", "a", "1", "calc", "url", ",", "px", "\t", "É", "var"];
    for (const s of gen(frags, 4000)) {
      expect(cssFunctionNames(s)).toEqual([...s.matchAll(/([a-z0-9_-]*)\s*\(/gi)].map((m) => m[1]));
    }
  });

  it("e-mail removal (lookbehind form)", () => {
    const frags = ["a", "é", "1", ".", "_", "%", "+", "-", "@", "b", "c.d", " ", "Ä", "x@y.z", "日", "."];
    let removed = 0;
    for (const s of gen(frags, 6000, 14)) {
      const expected = s.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, " ");
      if (expected !== s) removed++;
      expect(replaceEmailAddresses(s, " ")).toBe(expected);
    }
    expect(removed).toBeGreaterThan(100);
  });

  it("comments", () => {
    const frags = ["<!--", "-->", "<!-->", "a", " ", "--", ">", "<", "!"];
    for (const s of gen(frags, 4000)) expect(replaceComments(s, " ")).toBe(s.replace(/<!--[\s\S]*?-->/g, " "));
  });

  it("fragment stripping", () => {
    const frags = ["#", "a", "\n", "\r", "\u2028", " ", "/", "#x"];
    for (const s of gen(frags)) expect(stripFragment(s)).toBe(s.replace(/#.*$/, ""));
  });

  it("citations HEADER rewrite is equivalent", () => {
    const legacy = /^\s*(?:#{1,6}\s*|\*\*\s*)?(what|why|brief|was|warum|kurz)\b(?:\s*\*\*)?\s*:?\s*$/i;
    const next = /^\s*(?:#{1,6}\s*|\*\*\s*)?(what|why|brief|was|warum|kurz)\b\s*(?:\*\*\s*)?(?::\s*)?$/i;
    const frags = ["#", "##", "**", " ", ":", "WHAT", "why", "Brief", "kurz", "x", "\t", "was", "warum:", "\n"];
    let hits = 0;
    for (const s of gen(frags, 6000)) {
      const a = legacy.exec(s);
      if (a) hits++;
      expect(next.exec(s)?.slice(0, 2) ?? null).toEqual(a?.slice(0, 2) ?? null);
    }
    expect(hits).toBeGreaterThan(50);
  });
});
