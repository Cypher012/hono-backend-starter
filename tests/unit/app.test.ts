import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import { AppError } from "../../src/lib/errors";
import { createLogger } from "../../src/lib/logger";
import { createTaskRoutes } from "../../src/modules/tasks/routes";

async function setup(ping: (signal: AbortSignal) => Promise<void> = async () => {}, requestTimeoutMs = 1000) {
  const output: string[] = [];
  const config = loadConfig({ APP_ENV: "test", DATABASE_URL: "postgres://localhost/starter" });
  const logger = await createLogger(config, { write: (line) => { output.push(line); } });
  const app = createApp({ logger, ping, requestTimeoutMs });
  return { app, output };
}

test("liveness avoids PostgreSQL and readiness checks it", async () => {
  let probes = 0;
  const { app } = await setup(async () => { probes++; });
  const alive = await app.request("/healthz");
  expect(alive.status).toBe(200);
  expect(await alive.json()).toEqual({ status: "ok" });
  expect(probes).toBe(0);
  const ready = await app.request("/readyz");
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: "ready" });
  expect(probes).toBe(1);
});

test("unavailable readiness uses the error envelope and protects connection details", async () => {
  const { app, output } = await setup(async () => { throw new Error("postgres://user:secret@localhost/db"); });
  const response = await app.request("/readyz", { headers: { "X-Request-ID": "probe" } });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: { code: "unavailable", message: "database unavailable", request_id: "probe" },
  });
  expect(output.join("")).not.toContain("secret");
});

test("readiness returns 503 even when a probe ignores cancellation", async () => {
  let probeSignal: AbortSignal | undefined;
  const { app } = await setup((signal) => {
    probeSignal = signal;
    return new Promise<void>(() => {});
  }, 4000);
  const response = await app.request("/readyz");
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
  expect(probeSignal?.aborted).toBe(true);
});

test("propagates valid IDs and replaces missing, invalid, and overlong IDs", async () => {
  const { app, output } = await setup();
  const id = `${"a".repeat(61)}A_-`;
  const response = await app.request("/missing?token=private-query", {
    headers: { "X-Request-ID": id, authorization: "private-token", cookie: "private-cookie" },
  });
  expect(response.status).toBe(404);
  expect(response.headers.get("X-Request-ID")).toBe(id);
  expect(await response.json()).toEqual({
    error: { code: "not_found", message: "route not found", request_id: id },
  });
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0] ?? "")).toMatchObject({
    msg: "request", request_id: id, path: "/missing", method: "GET", status: 404, level: 40,
    duration_ms: expect.any(Number),
  });
  expect(output.join("")).not.toContain("private-");

  expect((await app.request("/healthz")).headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  for (const invalid of ["", "request=id", "spaces here", "a".repeat(65)]) {
    const generated = (await app.request("/healthz", { headers: { "X-Request-ID": invalid } }))
      .headers.get("X-Request-ID");
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated).not.toBe(invalid);
  }
});

test("maps application errors, Hono exceptions, and unexpected failures", async () => {
  const { app, output } = await setup();
  app.get("/rule", () => { throw new AppError(422, "limit_reached", "limit reached"); });
  app.get("/login", () => { throw new HTTPException(401); });
  app.get("/restricted", () => { throw new HTTPException(403); });
  app.get("/conflict", () => { throw new AppError(409, "conflict", "already exists"); });
  app.get("/broken", () => { throw new Error("postgres://user:secret@localhost\nSQL: private-value"); });
  app.get("/unknown", () => { throw "private-value"; });

  for (const [path, status, code, message] of [
    ["/rule", 422, "limit_reached", "limit reached"],
    ["/login", 401, "unauthenticated", "unauthenticated"],
    ["/restricted", 403, "forbidden", "forbidden"],
    ["/conflict", 409, "conflict", "already exists"],
    ["/broken", 500, "internal", "internal server error"],
    ["/unknown", 500, "internal", "internal server error"],
  ] as const) {
    const response = await app.request(path, { headers: { "X-Request-ID": "error-test" } });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message, request_id: "error-test" } });
  }
  const logEntry = z.looseObject({ msg: z.string(), status: z.number().optional() });
  const records = output.map((line) => logEntry.parse(JSON.parse(line)));
  const access = records.filter((record) => record.msg === "request");
  expect(access.map((record) => record.status)).toEqual([422, 401, 403, 409, 500, 500]);
  expect(records).toContainEqual(expect.objectContaining({
    msg: "request failed", request_id: "error-test",
    err: expect.objectContaining({ stack: expect.stringContaining("app.test.ts") }),
  }));
  expect(output.join("")).not.toContain("secret");
  expect(output.join("")).not.toContain("private-value");
});

test("deadline sends a single correlated 504 and signals cancellation", async () => {
  const { app, output } = await setup(undefined, 20);
  let signal: AbortSignal | undefined;
  const handlerDone = Promise.withResolvers<void>();
  app.get("/slow", async (c) => {
    signal = c.get("signal");
    await Bun.sleep(60);
    handlerDone.resolve();
    return c.json({ late: true });
  });
  const response = await app.request("/slow", { headers: { "X-Request-ID": "slow-request" } });
  expect(response.status).toBe(504);
  expect(response.headers.get("X-Request-ID")).toBe("slow-request");
  expect(await response.json()).toEqual({
    error: { code: "timeout", message: "request timed out", request_id: "slow-request" },
  });
  expect(signal?.aborted).toBe(true);
  await handlerDone.promise;
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0] ?? "")).toMatchObject({ status: 504, level: 50, msg: "request" });
});

test("tasks reject invalid requests before executing SQL", async () => {
  const { app } = await setup();
  app.route("/api/tasks", createTaskRoutes(drizzle.mock()));
  const headers = { "Content-Type": "application/json", "X-Request-ID": "validation-test" };
  const id = crypto.randomUUID();

  for (const [path, method, body, field] of [
    ["/api/tasks", "POST", '{"title":"   "}', "title"],
    ["/api/tasks", "POST", '{"title":"task","internal":true}', "body"],
    ["/api/tasks", "POST", '{"title":"task","description":"a\\u0000b"}', "description"],
    [`/api/tasks/${id}`, "PATCH", "{}", "body"],
    ["/api/tasks/invalid", "DELETE", undefined, "id"],
    ["/api/tasks?limit=101", "GET", undefined, "limit"],
  ] as const) {
    const response = await app.request(path, { method, body, headers });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_input", request_id: "validation-test", fields: { [field]: expect.any(String) } },
    });
  }
  const malformed = await app.request("/api/tasks", { method: "POST", body: "{", headers });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: { code: "bad_request" } });

  const oversized = await app.request("/api/tasks", { method: "POST", body: " ".repeat(1_048_577), headers });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ error: { code: "body_too_large" } });
});
