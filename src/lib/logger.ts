import pino from "pino";
import type { Config } from "../config/env";

export async function createLogger(config: Config, destination?: pino.DestinationStream) {
  const options: pino.LoggerOptions = {
    name: config.APP_NAME,
    level: config.LOG_LEVEL,
    base: { version: config.APP_VERSION },
    serializers: { err: safeError },
  };

  if (destination) return pino(options, destination);
  if (config.LOG_FORMAT === "pretty") {
    const { default: pretty } = await import("pino-pretty");
    return pino(options, pretty({ colorize: Boolean(process.stdout.isTTY), sync: true }));
  }
  return pino(options);
}

// Driver and ORM errors can include SQL parameters, connection details, and raw causes.
function safeError(error: unknown) {
  if (!(error instanceof Error)) return { type: "UnknownError" };
  const stack = error.stack;
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  return {
    type: "Error",
    stack: stack?.startsWith(`${header}\n`) ? stack.slice(header.length + 1) : undefined,
  };
}
