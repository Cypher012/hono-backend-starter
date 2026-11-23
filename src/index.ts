import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config/env";
import { createDatabase } from "./db";
import { createLogger } from "./lib/logger";
import { createTaskRoutes } from "./modules/tasks/routes";

async function main() {
  const config = loadConfig();
  const logger = await createLogger(config);
  const database = createDatabase(config);

  try {
    await database.ping(AbortSignal.timeout(5000));
    const app = createApp({
      logger,
      ping: database.ping,
      requestTimeoutMs: config.REQUEST_TIMEOUT_MS,
    });
    app.route("/api/tasks", createTaskRoutes(database.db));

    const server = Bun.serve({
      port: config.HTTP_PORT,
      fetch: app.fetch,
      idleTimeout: Math.max(
        10,
        Math.ceil(config.REQUEST_TIMEOUT_MS / 1000) + 5,
      ),
    });
    logger.info(
      {
        port: server.port,
        env: config.APP_ENV,
        max_conns: config.DB_MAX_CONNS,
      },
      "server started",
    );

    let stopping = false;

    async function shutdown(signal: NodeJS.Signals) {
      if (stopping) return;
      stopping = true;
      logger.info({ signal }, "shutdown requested");

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const gracePeriodExpired = new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), config.SHUTDOWN_TIMEOUT_MS);
        });
        const drained = await Promise.race([
          server.stop().then(() => true),
          gracePeriodExpired,
        ]);
        if (!drained) {
          logger.warn("shutdown grace period expired");
          await server.stop(true);
        }
        await database.close();
        logger.info({ drained }, "shutdown complete");
      } catch (err) {
        logger.error({ err }, "shutdown failed");
        process.exitCode = 1;
        await Promise.allSettled([server.stop(true), database.close()]);
      } finally {
        clearTimeout(timer);
      }
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    logger.error({ err }, "startup failed");
    try {
      await database.close();
    } catch (closeError) {
      logger.error({ err: closeError }, "database cleanup failed");
    }
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(
      err instanceof ConfigError
        ? `${err.message}\n`
        : "Could not initialize the API\n",
    );
    process.exitCode = 1;
  }
}
