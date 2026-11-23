import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { AppError, errorResponse, handleError } from "./lib/errors";
import { requestDeadline, requestId, requestLogger, type AppEnv } from "./middleware/request";

type AppOptions = {
  logger: Logger;
  ping: (signal: AbortSignal) => Promise<void>;
  requestTimeoutMs: number;
};

export function createApp({ logger, ping, requestTimeoutMs }: AppOptions) {
  const app = new Hono<AppEnv>();

  app.use(requestId);
  app.use(requestLogger(logger));
  app.use(requestDeadline(requestTimeoutMs));
  app.use(bodyLimit({
    maxSize: 1024 * 1024,
    onError: () => { throw new AppError(413, "body_too_large", "body must be at most 1048576 bytes"); },
  }));

  app.onError(handleError);
  app.notFound((c) => errorResponse(c, new AppError(404, "not_found", "route not found")));

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", requestDeadline(2000, 503), async (c) => {
    try {
      await ping(c.get("signal"));
    } catch (err) {
      c.get("logger").warn({ err }, "database readiness check failed");
      throw new AppError(503, "unavailable", "database unavailable");
    }
    return c.json({ status: "ready" });
  });

  return app;
}
