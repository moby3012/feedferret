const isDev = process.env.NODE_ENV !== "production";

function fmt(level: string, ...args: unknown[]) {
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
