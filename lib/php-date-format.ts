// A small, pure re-implementation of the useful subset of PHP's
// `DateTime::createFromFormat()`. FreshRSS stores the format of a scraped item's
// date in `frss:xPathItemTimeFormat` (e.g. `d.m.Y`, `d/m/Y H:i`, `j. F Y`), so a
// scraped feed can only be read faithfully with the same grammar.
//
// Supported format characters:
//   d j      day of month (1–2 digits)           m n      month number (1–2 digits)
//   y        2-digit year (<70 → 20xx, else 19xx) Y        4-digit year
//   H G      24h hour (1–2 digits)                h g      12h hour (1–2 digits)
//   i s      minutes / seconds (2 digits)         u v      fraction (1–6 / 3 digits)
//   A a      AM/PM                                D l      day name (checked, not applied)
//   M F      month name (full or short)           U        Unix seconds (optionally signed)
//   e T O P p  time zone: Z, UTC, GMT, ±hh[:]mm   c r      ISO 8601 / RFC 2822 shorthands
//   \x       escaped literal                      ! |      reset to the epoch (all / rest)
//   ? * +    any char / up to next separator / ignore the rest
//   everything else matches itself (whitespace in the input is normalised first).
//
// Deliberate differences from PHP (every one makes the parser stricter or
// deterministic — a configured format must never *guess*):
//   - A string that does not match the format entirely, or names an impossible
//     date/time (31 Feb, 25:00, 13th month …) returns `null` instead of PHP's
//     overflow-with-warnings.
//   - Fields the format does not mention are not taken from "now": a date-only
//     format yields local midnight; a missing day/month defaults to the 1st of the
//     period given (`F Y` → first of that month). Only formats with no date field at
//     all (`H:i`) use today's date. `!` / `|` switch the defaults to 1970-01-01 as in PHP.
//   - `Y` needs 4 digits, `i`/`s` 2 digits.
//   - Month / day names are matched case-insensitively in English, plus German as a
//     tolerant extension (`Januar`, `März`/`Maerz`, `Okt.`, `Mo`, `Donnerstag` …).
//   - `s` tolerates a trailing fraction (`10:00:00.123`) so `c` works on JS-style ISO.
//
// No time zone in the string → server-local time, exactly like the previous
// `new Date(string)` guessing did.

type NameEntry = readonly [name: string, value: number];

const MONTH_NAMES: ReadonlyArray<NameEntry> = [
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
  ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["jun", 6], ["jul", 7], ["aug", 8],
  ["sept", 9], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
  // German (tolerant extension).
  ["januar", 1], ["februar", 2], ["märz", 3], ["maerz", 3], ["marz", 3], ["juni", 6], ["juli", 7],
  ["oktober", 10], ["dezember", 12],
  ["jän", 1], ["mär", 3], ["mrz", 3], ["mai", 5], ["okt", 10], ["dez", 12],
];

const DAY_NAMES: ReadonlyArray<NameEntry> = [
  ["monday", 1], ["tuesday", 2], ["wednesday", 3], ["thursday", 4], ["friday", 5], ["saturday", 6], ["sunday", 0],
  ["mon", 1], ["tues", 2], ["tue", 2], ["wed", 3], ["thurs", 4], ["thur", 4], ["thu", 4], ["fri", 5], ["sat", 6], ["sun", 0],
  // German
  ["montag", 1], ["dienstag", 2], ["mittwoch", 3], ["donnerstag", 4], ["freitag", 5], ["samstag", 6], ["sonnabend", 6], ["sonntag", 0],
  ["mo", 1], ["di", 2], ["mi", 3], ["do", 4], ["fr", 5], ["sa", 6], ["so", 0],
];

// Longest name first so "march" wins over "mar" and "juni" over "jun".
const byLength = (a: NameEntry, b: NameEntry) => b[0].length - a[0].length;
const MONTHS_LONGEST_FIRST = [...MONTH_NAMES].sort(byLength);
const DAYS_LONGEST_FIRST = [...DAY_NAMES].sort(byLength);

const SEPARATORS = new Set([";", ":", "/", ".", ",", "-", "(", ")", " "]);

/** `c` and `r` expand to fixed formats (before any escaping is processed). */
function expandShorthands(format: string): string {
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch === "\\") {
      out += ch + (format[i + 1] ?? "");
      i++;
    } else if (ch === "c") {
      out += "Y-m-d\u0000H:i:sP"; // Internal token: ISO separator accepts T or t.
    } else if (ch === "r") {
      out += "D, d M Y H:i:s O";
    } else {
      out += ch;
    }
  }
  return out;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function matchName(rest: string, names: ReadonlyArray<NameEntry>): { value: number; length: number } | null {
  const lower = rest.toLowerCase();
  for (const [name, value] of names) {
    if (!lower.startsWith(name)) continue;
    // A name must end at a word boundary ("Maybe" is not "May").
    const next = lower[name.length];
    if (next !== undefined && /\p{L}/u.test(next)) continue;
    return { value, length: name.length };
  }
  return null;
}

export type PhpDateParseOptions = {
  /** "Today" for formats without any date field (tests). Defaults to the current time. */
  now?: Date;
};

type Fields = {
  year: number | null;
  month: number | null;
  day: number | null;
  hour: number | null;
  minute: number | null;
  second: number | null;
  millis: number | null;
  pm: boolean | null;
  /** Zone offset in minutes east of UTC; `null` = server-local time. */
  offset: number | null;
  epoch: number | null;
};

const emptyFields = (): Fields => ({
  year: null, month: null, day: null, hour: null, minute: null, second: null,
  millis: null, pm: null, offset: null, epoch: null,
});

/**
 * Parse `input` with a PHP `createFromFormat` `format`. Returns `null` when the
 * string does not match the format or is not a real date/time.
 */
export function parsePhpDate(input: string, format: string, options: PhpDateParseOptions = {}): Date | null {
  const text = input.normalize("NFC").replace(/\s+/g, " ").trim();
  const fmt = expandShorthands(format.trim());
  if (!text || !fmt) return null;

  let f = emptyFields();
  let epochDefaults = false;
  let ignoreRest = false;
  let p = 0;

  const digits = (min: number, max: number): number | null => {
    let end = p;
    while (end < text.length && end - p < max && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
    if (end - p < min) return null;
    const value = Number(text.slice(p, end));
    p = end;
    return value;
  };

  /** Consume an optional "." after an abbreviated name unless the format wants a literal "." next. */
  const optionalDot = (fi: number) => {
    if (text[p] === "." && fmt[fi + 1] !== "." && !(fmt[fi + 1] === "\\" && fmt[fi + 2] === ".")) p++;
  };

  for (let fi = 0; fi < fmt.length; fi++) {
    const ch = fmt[fi];
    switch (ch) {
      case "\u0000": if (text[p] !== "T" && text[p] !== "t") return null; p++; break;
      case " ":
        if (text[p] !== " ") return null;
        p++;
        while (fmt[fi + 1] === " ") fi++;
        break;
      case "d": case "j": { const v = digits(1, 2); if (v === null) return null; f.day = v; break; }
      case "m": case "n": { const v = digits(1, 2); if (v === null) return null; f.month = v; break; }
      case "y": {
        const v = digits(2, 2);
        if (v === null) return null;
        f.year = v < 70 ? 2000 + v : 1900 + v;
        break;
      }
      case "Y": { const v = digits(4, 4); if (v === null) return null; f.year = v; break; }
      case "H": case "G": case "h": case "g": {
        const v = digits(1, 2);
        if (v === null) return null;
        f.hour = v;
        break;
      }
      case "i": { const v = digits(2, 2); if (v === null) return null; f.minute = v; break; }
      case "s": {
        const v = digits(2, 2);
        if (v === null) return null;
        f.second = v;
        // Tolerated fraction, see header comment.
        const frac = /^[.,](\d{1,9})/.exec(text.slice(p));
        if (frac && fmt[fi + 1] !== "." && fmt[fi + 1] !== ",") {
          f.millis = Number(frac[1].padEnd(3, "0").slice(0, 3));
          p += frac[0].length;
        }
        break;
      }
      case "u": case "v": {
        const start = p;
        const v = digits(ch === "v" ? 3 : 1, ch === "v" ? 3 : 6);
        if (v === null) return null;
        f.millis = Number(text.slice(start, p).padEnd(3, "0").slice(0, 3));
        break;
      }
      case "A": case "a": {
        const m = /^([ap])\.?m\.?/i.exec(text.slice(p));
        if (!m) return null;
        f.pm = m[1].toLowerCase() === "p";
        p += m[0].length;
        break;
      }
      case "M": case "F": {
        const hit = matchName(text.slice(p), MONTHS_LONGEST_FIRST);
        if (!hit) return null;
        f.month = hit.value;
        p += hit.length;
        optionalDot(fi);
        break;
      }
      case "D": case "l": {
        const hit = matchName(text.slice(p), DAYS_LONGEST_FIRST);
        if (!hit) return null;
        p += hit.length;
        optionalDot(fi);
        break;
      }
      case "U": {
        const m = /^-?\d+/.exec(text.slice(p));
        if (!m) return null;
        f.epoch = Number(m[0]);
        p += m[0].length;
        break;
      }
      case "e": case "T": case "O": case "P": case "p": {
        const m = /^(?:z|utc|gmt|([+-])(\d{2})(?::?(\d{2}))?)/i.exec(text.slice(p));
        if (!m) return null;
        if (m[1]) {
          const hours = Number(m[2]);
          const minutes = Number(m[3] ?? "0");
          if (hours > 23 || minutes > 59) return null;
          f.offset = (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
        } else {
          f.offset = 0;
        }
        p += m[0].length;
        break;
      }
      case "\\": {
        fi++;
        const lit = fmt[fi];
        if (lit === undefined || text[p] !== lit) return null;
        p++;
        break;
      }
      case "!": f = emptyFields(); epochDefaults = true; break;
      case "|": epochDefaults = true; break;
      case "?": if (p >= text.length) return null; p++; break;
      case "*": while (p < text.length && !SEPARATORS.has(text[p]) && !/\d/.test(text[p])) p++; break;
      case "+": p = text.length; ignoreRest = true; break;
      default:
        // Separators and any other character must match literally.
        if (text[p] !== ch) return null;
        p++;
    }
  }
  if (!ignoreRest && p !== text.length) return null;

  return assemble(f, epochDefaults, options.now ?? new Date());
}

function assemble(f: Fields, epochDefaults: boolean, now: Date): Date | null {
  if (f.epoch !== null) {
    const date = new Date(f.epoch * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const hasDateField = f.year !== null || f.month !== null || f.day !== null;
  let year: number;
  let month: number;
  let day: number;
  if (epochDefaults) {
    year = f.year ?? 1970;
    month = f.month ?? 1;
    day = f.day ?? 1;
  } else if (hasDateField) {
    // Lower-order fields default to the start of the period given.
    year = f.year ?? now.getFullYear();
    month = f.month ?? 1;
    day = f.day ?? 1;
  } else {
    year = now.getFullYear();
    month = now.getMonth() + 1;
    day = now.getDate();
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;

  let hour = f.hour ?? 0;
  if (f.pm !== null) {
    if (f.hour === null || hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (f.pm ? 12 : 0);
  }
  const minute = f.minute ?? 0;
  const second = f.second ?? 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millis = f.millis ?? 0;

  let date: Date;
  if (f.offset === null) {
    date = new Date(2000, 0, 1, 0, 0, 0, 0);
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, second, millis);
  } else {
    date = new Date(Date.UTC(2000, 0, 1));
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, millis);
    date = new Date(date.getTime() - f.offset * 60_000);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}
