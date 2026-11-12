// N1 PR C: the Cloudflare Email Worker the wizard hands out. Kept as a string
// (not a file under scripts/) so the standalone Docker image ships it and the
// browser can fill in URL + secret client-side. tests/lib/cloudflare-email-worker
// runs this exact source against the server's signature check.
//
// The worker signs `timestamp \n recipient \n body` with HMAC-SHA256 (see
// lib/inbound-email-webhook.ts) and POSTs the raw message. No backticks or
// dollar-brace sequences in here: it is a String.raw template.

export const WORKER_URL_PLACEHOLDER = "__FEEDFERRET_WEBHOOK_URL__";
export const WORKER_SECRET_PLACEHOLDER = "__FEEDFERRET_WEBHOOK_SECRET__";

export const CLOUDFLARE_EMAIL_WORKER_TEMPLATE = String.raw`// FeedFerret – Cloudflare Email Worker
// Forwards every mail that Cloudflare Email Routing hands to this worker to your FeedFerret server.
// Treat this script like a password: it contains the secret that authenticates your mails.

const WEBHOOK_URL = "__FEEDFERRET_WEBHOOK_URL__";
const WEBHOOK_SECRET = "__FEEDFERRET_WEBHOOK_SECRET__";
const MAX_BYTES = 10 * 1024 * 1024;

const encoder = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// HMAC-SHA256 over: timestamp + "\n" + recipient + "\n" + raw message
async function sign(timestamp, recipient, body) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const head = encoder.encode(timestamp + "\n" + recipient + "\n");
  const payload = new Uint8Array(head.length + body.byteLength);
  payload.set(head, 0);
  payload.set(new Uint8Array(body), head.length);
  return toHex(await crypto.subtle.sign("HMAC", key, payload));
}

export default {
  async email(message, env, ctx) {
    if (message.rawSize > MAX_BYTES) {
      message.setReject("Message too large");
      return;
    }
    const body = await new Response(message.raw).arrayBuffer();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const recipient = message.to;
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-feedferret-timestamp": timestamp,
        "x-feedferret-recipient": recipient,
        "x-feedferret-signature": "sha256=" + (await sign(timestamp, recipient, body)),
      },
      body,
    });
    if (response.ok) return;
    // Permanent problems (wrong secret, source paused or removed, too large): bounce.
    if ([401, 403, 404, 410, 413].includes(response.status)) {
      message.setReject("Not accepted by FeedFerret (HTTP " + response.status + ")");
      return;
    }
    // Temporary problems (server down, rate limited): let Cloudflare retry / report.
    throw new Error("FeedFerret answered HTTP " + response.status);
  },
};
`;

/** The script with URL and secret filled in (values are JSON-escaped string literals). */
export function renderCloudflareEmailWorker(webhookUrl: string, secret: string): string {
  return CLOUDFLARE_EMAIL_WORKER_TEMPLATE.replace(JSON.stringify(WORKER_URL_PLACEHOLDER), () => JSON.stringify(webhookUrl)).replace(
    JSON.stringify(WORKER_SECRET_PLACEHOLDER),
    () => JSON.stringify(secret),
  );
}
