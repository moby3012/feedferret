export type ChannelPayload = {
  title: string;
  body: string;
  url?: string;
};

export type TelegramConfig = {
  botToken: string;
  chatId: string;
};

export type GotifyConfig = {
  url: string;
  token: string;
  priority?: number;
};

export type NtfyConfig = {
  url: string;
  token?: string;
  priority?: number;
};

// Escape special chars required by Telegram MarkdownV2.
function escapeTgMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export async function sendTelegramNotification(
  config: TelegramConfig,
  payload: ChannelPayload,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const lines = [`*${escapeTgMd(payload.title)}*`, escapeTgMd(payload.body)];
    if (payload.url) lines.push(`[Open article](${payload.url})`);
    const text = lines.join("\n");

    const res = await fetch(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${err.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendGotifyNotification(
  config: GotifyConfig,
  payload: ChannelPayload,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const base = config.url.replace(/\/$/, "");
    const res = await fetch(`${base}/message?token=${encodeURIComponent(config.token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: payload.title,
        message: payload.url ? `${payload.body}\n\n${payload.url}` : payload.body,
        priority: config.priority ?? 5,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${err.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendNtfyNotification(
  config: NtfyConfig,
  payload: ChannelPayload,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Title": payload.title,
      "X-Priority": String(config.priority ?? 3),
    };
    if (payload.url) headers["X-Click"] = payload.url;
    if (config.token) headers["Authorization"] = `Bearer ${config.token}`;

    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body: payload.body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${err.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
