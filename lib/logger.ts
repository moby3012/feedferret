import { redactValue } from "./redact";
const isDev = process.env.NODE_ENV !== "production";

function fmt(level: string, ...args: unknown[]) {
  args = args.map(arg => redactValue(arg));
  if (typeof args[0] === "string") {
    return [`[${level}] ${args[0]}`, ...args.slice(1)];
  }
  return [`[${level}]`, ...args];
}

export const logger = {
  debug: isDev ? (...args: unknown[]) => console.debug(...fmt("debug", ...args)) : () => {},
  log:   isDev ? (...args: unknown[]) => console.log(...fmt("log", ...args))     : () => {},
  info:  isDev ? (...args: unknown[]) => console.info(...fmt("info", ...args))   : () => {},
  warn:  (...args: unknown[]) => console.warn(...fmt("warn", ...args)),
  error: (...args: unknown[]) => console.error(...fmt("error", ...args)),
};

/**
 * Origin only, for log lines: feed and webhook URLs can carry tokens in the
 * query (`?key=`, `?token=`), userinfo (`user:pass@`) or path (Discord /
 * Slack webhooks), and logs are readable by more people than the DB (N15).
 */
export function urlForLog(rawUrl: string | null | undefined): string {
  try {
    return new URL(String(rawUrl)).origin;
  } catch {
    return "(invalid URL)";
  }
}
