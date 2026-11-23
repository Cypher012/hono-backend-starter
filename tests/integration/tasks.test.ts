import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import { createLogger } from "../../src/lib/logger";
import { createTaskRoutes } from "../../src/modules/tasks/routes";

const testUrl = Bun.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)("tasks with PostgreSQL", () => {
  const namespace = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  let sql: ReturnType<typeof postgres> | undefined;
  let schemaCreated = false;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: testUrl, APP_ENV: "test", LOG_LEVEL: "silent" });
    const url = new URL(config.DATABASE_URL);
    url.searchParams.set("search_path", namespace);
    sql = postgres(url.toString(), { max: 1, onnotice() {} });
    const [settings] = await sql<{ search_path: string }[]>`show search_path`;
    if (settings?.search_path !== namespace) throw new Error("test schema isolation failed");
    await sql`CREATE SCHEMA ${sql(namespace)}`;
    schemaCreated = true;
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: "drizzle", migrationsSchema: namespace });

    const client = sql;
    app = createApp({
      logger: await createLogger(config),
      ping: async (signal) => { await client`select 1`.signal(signal); },
      requestTimeoutMs: 1000,
    });
    app.route("/api/tasks", createTaskRoutes(db));
  });

  afterAll(async () => {
    if (!sql) return;
    try {
      if (schemaCreated) await sql`DROP SCHEMA ${sql(namespace)} CASCADE`;
    } finally {
      await sql.end({ timeout: 2 });
    }
  });

  test("migrates and runs the task lifecycle in an isolated schema", async () => {
    expect((await app.request("/readyz")).status).toBe(200);
    expect(await (await app.request("/api/tasks")).json()).toEqual([]);
    const headers = { "Content-Type": "application/json" };
    const create = await app.request("/api/tasks", {
      method: "POST", headers, body: JSON.stringify({ title: "  Starter task  ", description: "Example" }),
    });
    expect(create.status).toBe(201);
    const task = z.object({
      id: z.uuid(),
      title: z.string(),
      description: z.string().nullable(),
      completed: z.boolean(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    }).parse(await create.json());
    const path = `/api/tasks/${task.id}`;
    expect(create.headers.get("Location")).toBe(path);
    expect(task).toMatchObject({ title: "Starter task", description: "Example", completed: false });
    expect(await (await app.request("/api/tasks?limit=1")).json()).toEqual([task]);
    expect(await (await app.request("/api/tasks?offset=1")).json()).toEqual([]);
    expect(await (await app.request(path)).json()).toEqual(task);

    const update = await app.request(path, {
      method: "PATCH", headers, body: JSON.stringify({ completed: true, description: null }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      id: task.id, title: task.title, completed: true, description: null, createdAt: task.createdAt,
    });
    const deleted = await app.request(path, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const response = await app.request(path, {
        method, headers, body: method === "PATCH" ? '{"completed":false}' : undefined,
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });
});
