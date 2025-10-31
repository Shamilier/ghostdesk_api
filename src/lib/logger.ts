export type LogLevel = "debug" | "info" | "warn" | "error";

function log(level: LogLevel, message: string, payload?: Record<string, unknown>) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(payload ?? {}),
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  debug: (message: string, payload?: Record<string, unknown>) =>
    log("debug", message, payload),
  info: (message: string, payload?: Record<string, unknown>) =>
    log("info", message, payload),
  warn: (message: string, payload?: Record<string, unknown>) =>
    log("warn", message, payload),
  error: (message: string, payload?: Record<string, unknown>) =>
    log("error", message, payload),
};
