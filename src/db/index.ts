import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config/env";

export type Database = PostgresJsDatabase;

export function createDatabase(config: Config) {
  const client = postgres(config.DATABASE_URL, {
    max: config.DB_MAX_CONNS,
    connect_timeout: 3,
    idle_timeout: 30,
    // One in-flight query per connection keeps cancellations isolated.
    max_pipeline: 1,
    query_timeout: config.REQUEST_TIMEOUT_MS / 1000,
    cancel_timeout: 1,
    connection: { statement_timeout: config.REQUEST_TIMEOUT_MS },
    onnotice() {},
  });

  return {
    db: drizzle(client),
    async ping(signal: AbortSignal) {
      await client`select 1`.signal(signal);
    },
    close: () => client.end({ timeout: 5 }),
  };
}
