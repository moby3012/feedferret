// Parse-free newsletter hygiene helpers (size caps, tracking-param and
// tracking-pixel rules, shared types), used by the main-thread ingest
// (lib/inbound-email.ts) and the worker-side sanitizer (lib/newsletter-html.ts).

/** HTML bodies are cut before sanitizing (DOMPurify re-balances the markup). */
export const MAX_HTML_CHARS = 2_000_000;
export const MAX_TEXT_CHARS = 500_000;

const TRACKING_PARAM_RE = /^(?:utm_[a-z_]+|mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|ck_subscriber_id|vero_id|vero_conv|oly_enc_id|oly_anon_id|rb_clickid|s_cid|ml_subscriber|ml_subscriber_hash|ss_source|ss_campaign_id|ss_email_id|fbclid|gclid|msclkid|yclid|igshid|_bhlid|r_lang)$/i;

/** Drops known tracking query params from an http(s) URL; returns the input unchanged otherwise. */
export function stripTrackingParams(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return href;
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? url.toString() : href;
}

const TRACKER_IMAGE_HOST_RE = /(?:^|\.)(?:eotrx\.substackcdn\.com|open\.substack\.com|list-manage\.com|mailchimpapp\.net|open\.convertkit-mail\d*\.com|convertkit-mail\d*\.com|email\.mg\.[^/]+|sendgrid\.net|ct\.sendgrid\.net|track\.hubspot\.com|t\.hubspotemail\.net|mailtrack\.io|pixel\.mailerlite\.com|trk\.klclick\d*\.com|links\.mail\.beehiiv\.com|link\.mail\.beehiiv\.com|mandrillapp\.com|mcsv\.net|exct\.net|cmail\d+\.com|createsend\d*\.com)$/i;
const TRACKER_IMAGE_PATH_RE = /(?:^|\/)(?:track\/open(?:\.php)?|wf\/open|open\.(?:php|gif|png|aspx)|ss\/o|e\/o|o|open|pixel(?:\.gif|\.png)?|beacon|trk)(?:\/|$|\?)/i;

function isTinyDimension(value: string | null | undefined): boolean {
  if (value == null || value === "") return false;
  const n = parseFloat(value);
  return Number.isFinite(n) && n <= 1;
}

function styleValue(style: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(style);
  return m ? m[1].trim().toLowerCase() : null;
}

/** 1×1 / invisible / known open-tracking images. */
export function isTrackingImage(img: { src: string; width?: string | null; height?: string | null; style?: string | null }): boolean {
  const style = img.style ?? "";
  if (isTinyDimension(img.width) || isTinyDimension(img.height)) return true;
  const sw = styleValue(style, "width");
  const sh = styleValue(style, "height");
  if ((sw && /^[\d.]+(?:px)?$/.test(sw) && isTinyDimension(sw)) || (sh && /^[\d.]+(?:px)?$/.test(sh) && isTinyDimension(sh))) return true;
  if (styleValue(style, "opacity") === "0" || styleValue(style, "visibility") === "hidden") return true;
  let url: URL;
  try {
    url = new URL(img.src);
  } catch {
    return false;
  }
  if (TRACKER_IMAGE_HOST_RE.test(url.hostname)) return true;
  return /(?:^|\.)(?:email|mail|click|track|trk|link|links|open|t)\./i.test(url.hostname) && TRACKER_IMAGE_PATH_RE.test(url.pathname);
}

export interface InlineImage {
  contentId: string;
  mimeType: string;
  base64: string;
  bytes: number;
}

export interface LinkInfo {
  href: string;
  text: string;
}
