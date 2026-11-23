import { expect, test } from "bun:test";
import { loadConfig, loadDatabaseUrl } from "../../src/config/env";

const DATABASE_URL = "postgres://user:password@localhost/starter";

test("loads defaults and chooses structured production logs", () => {
  expect(loadConfig({ DATABASE_URL })).toMatchObject({
    HTTP_PORT: 3000,
    APP_ENV: "development",
    LOG_FORMAT: "pretty",
    REQUEST_TIMEOUT_MS: 30_000,
  });
  expect(loadConfig({ DATABASE_URL, APP_ENV: "production", DB_MAX_CONNS: "1" })).toMatchObject({
    LOG_FORMAT: "json",
    DB_MAX_CONNS: 1,
  });
});

test("reports invalid settings without exposing the connection string", () => {
  expect(() => loadConfig({ HTTP_PORT: "0", SHUTDOWN_TIMEOUT_MS: "soon" }))
    .toThrow(/DATABASE_URL:[\s\S]*HTTP_PORT:[\s\S]*SHUTDOWN_TIMEOUT_MS:/);
  expect(() => loadDatabaseUrl({ DATABASE_URL: "https://user:private-value@localhost" }))
    .toThrow("expected a PostgreSQL URL with a host");
  try {
    loadDatabaseUrl({ DATABASE_URL: "https://user:private-value@localhost" });
  } catch (err) {
    expect(String(err)).not.toContain("private-value");
  }
});

test("database tooling only needs the database settings", () => {
  expect(loadDatabaseUrl({ DATABASE_URL, HTTP_PORT: "unused" })).toBe(DATABASE_URL);
});
