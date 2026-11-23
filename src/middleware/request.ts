import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { timeout } from "hono/timeout";
import type { Logger } from "pino";

export type AppEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
    signal: AbortSignal;
  };
};

export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header("X-Request-ID");
  const id = incoming && incoming.length <= 64 && !/[^A-Za-z0-9_-]/.test(incoming)
    ? incoming : crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-ID", id);
  await next();
});

export const requestLogger = (logger: Logger) => createMiddleware<AppEnv>(async (c, next) => {
  const start = performance.now();
  const log = logger.child({ request_id: c.get("requestId") });
  c.set("logger", log);
  await next();

  const { status } = c.res;
  const fields = { method: c.req.method, path: c.req.path, status, duration_ms: performance.now() - start };
  if (status >= 500) log.error(fields, "request");
  else if (status >= 400) log.warn(fields, "request");
  else log.info(fields, "request");
});

export const requestDeadline = (ms: number, status: 503 | 504 = 504) => createMiddleware<AppEnv>((c, next) => {
  const deadline = new AbortController();
  c.set("signal", AbortSignal.any([c.get("signal") ?? c.req.raw.signal, deadline.signal]));
  return timeout(ms, () => {
    const error = new HTTPException(status);
    deadline.abort(error);
    return error;
  })(c, () => next().catch((cause: unknown) => {
    // Hono forwards Error instances to onError.
    throw cause instanceof Error ? cause : new Error("non-Error value thrown");
  }));
});
