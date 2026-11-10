// Stopwords (de + en) for headline tokenization. Matched after lowercasing and
// ß→ss folding, before stemming. Deliberately small: headline filler, function
// words and news boilerplate ("says", "report", "neu").

const DE =
  "aber alle allem allen aller alles also am an andere anderen auch auf aus bei beim bin bis bist da dabei dadurch dafuer dagegen daher damit dann dass dazu dem den denn der des die dies diese diesem diesen dieser dieses doch dort du durch ein eine einem einen einer eines einmal er es etwa euch euer fuer gegen gibt hat hatte haben hier hin hinter ich ihr ihre ihrem ihren ihrer im immer in ist ja jede jedem jeden jeder jedes jetzt kann kein keine koennen konnte machen man mehr mit muss nach nicht noch nun nur ob oder ohne sehr sein seine seinem seinen seiner seit sich sie sind so sollen soll sowie ueber um und uns unser unter vom von vor waehrend war waren was weil weiter wenn wer werden wie wieder will wir wird wurde wurden zu zum zur zwischen neue neuer neues neuen neu jetzt heute gestern morgen nun laut zeigt jahr jahre jahren woche wochen monat monate tag tage  zeigen bleibt bleiben wegen bereits schon erneut offenbar sagt sagte teils rund mehrere viele vieler".split(
    /\s+/,
  );

const EN =
  "a about above after again against all also an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my new no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your says say said report reports reported according still yet today get gets got one just will may might us amid after over year years later ago last next week weeks month months day days here's what's how's why's".split(
    /\s+/,
  );

export const STOPWORDS_DE: ReadonlySet<string> = new Set(DE);
export const STOPWORDS_EN: ReadonlySet<string> = new Set(EN);
export const STOPWORDS: ReadonlySet<string> = new Set([...DE, ...EN]);

/**
 * Title prefixes that mark a news *format*, not a topic. Stripped before
 * tokenizing ("Eilmeldung: …", "Breaking – …", "Update: …").
 */
export const PREFIX_RE =
  /^\s*(?:eilmeldung|breaking(?:\s+news)?|update|exklusiv|exclusive|liveblog|live|video|podcast|kommentar|opinion|analyse|analysis|news)\s*[:+|\-–—]\s*/i;

/** Titles whose feed items are rolling/aggregate formats and never join a story. */
export const EXCLUDE_TITLE_RE =
  /^\s*(?:liveblog|live-?ticker|live|ticker|newsletter|podcast|presseschau|the morning|morning briefing|der morgen|wochenr[uü]ckblick|week in review|links? (?:of|for) the|news(?:letter)? roundup|daily digest|tagesschau in \d+ minuten)\b/i;

/**
 * Small curated alias table: surface form(s) → canonical entity id. Covers the
 * abbreviation/long-form pairs that headlines alternate between ("EZB" vs
 * "Europäische Zentralbank", "Fed" vs "Federal Reserve"), which pure token
 * overlap cannot see. Keys are lowercased, ß→ss, tokens joined by one space.
 */
export const ENTITY_ALIASES: ReadonlyArray<readonly [canonical: string, forms: readonly string[]]> = [
  ["ecb", ["ezb", "ecb", "europaeische zentralbank", "european central bank", "europäische zentralbank"]],
  ["fed", ["fed", "federal reserve", "us-notenbank", "us notenbank"]],
  ["eu", ["eu", "european union", "europaeische union", "europäische union", "eu-kommission", "eu commission", "european commission"]],
  ["un", ["vereinte nationen", "united nations"]],
  ["nato", ["nato"]],
  ["bundesbank", ["bundesbank"]],
  ["openai", ["openai", "open ai"]],
];

/**
 * Newsroom verb synonyms (folded surface form → canonical token). Different
 * outlets word the same event differently ("beschließt" / "stimmt für" /
 * "verabschiedet", "unveils" / "announces" / "launches"); mapping them to one
 * token lets the overlap terms see the agreement. Canonical tokens are weak
 * (see WEAK_WORDS): they support a match but never carry it alone.
 */
export const SYNONYMS: Readonly<Record<string, string>> = (() => {
  const groups: Record<string, string> = {
    vote: "beschliesst beschliessen beschloss beschlossen verabschiedet verabschieden stimmt billigt passes approves approved votes voted",
    unveil: "praesentiert praesentieren enthuellt unveils unveiled announces announced announce launches launched launch releases released release introduces introduced debuts reveals revealed",
    cut: "senkt senken kuerzt kuerzen cuts lowers lowered slashes reduces reduced",
    hold: "haelt belaesst holds keeps kept maintains",
    raise: "erhoeht erhoehen hebt raises raised lifts hikes",
  };
  const out: Record<string, string> = {};
  for (const [canonical, words] of Object.entries(groups)) for (const w of words.split(" ")) out[w] = canonical;
  return out;
})();

/**
 * Generic headline words that appear in many unrelated stories. They still
 * count towards the overlap terms (down-weighted) but never satisfy the
 * "≥ 2 shared tokens" gate on their own. Entries are folded surface forms
 * (matched after stemming too) plus the canonical synonym tokens.
 */
export const WEAK_WORDS: ReadonlySet<string> = new Set(
  (
    "vote unveil cut hold raise kuendigt kuendigen bringt bringen gibt geben kommt kommen startet starten plant planen fordert fordern warnt warnen " +
    "zeigt erklaert nennt fuehrt faellt steigt steigen sinkt sinken wird werden macht holen holt stellt " +
    "plans plan set sets gets takes make makes makes calls says warns shows wins win could would"
  ).split(" "),
);
