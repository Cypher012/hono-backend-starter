import { zValidator } from "@hono/zod-validator";
import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../../db";
import { tasks } from "../../db/schema";
import { AppError } from "../../lib/errors";
import type { AppEnv } from "../../middleware/request";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) => !value.includes("\0"),
      "must not contain a null character",
    );
const title = text(200).pipe(z.string().min(1, "is required"));
const description = text(2000).nullable();
const createTask = z.strictObject({
  title,
  description: description.optional(),
  completed: z.boolean().default(false),
});
const updateTask = z
  .strictObject({
    title: title.optional(),
    description: description.optional(),
    completed: z.boolean().optional(),
  })
  .refine(
    (input) => Object.keys(input).length > 0,
    "provide at least one field to update",
  );
const taskId = z.object({ id: z.uuid() });
const listTasks = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
});

function validate(
  result:
    | { success: true }
    | { success: false; error: { issues: z.ZodError["issues"] } },
) {
  if (result.success) return;
  const fields = new Map<string, string>();
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "body";
    if (!fields.has(key)) {
      fields.set(
        key,
        issue.code === "unrecognized_keys"
          ? "contains unrecognized fields"
          : issue.message,
      );
    }
  }
  throw new AppError(
    422,
    "invalid_input",
    "invalid input",
    Object.fromEntries(fields),
  );
}

export function createTaskRoutes(db: Database) {
  return new Hono<AppEnv>()
    .post("/", zValidator("json", createTask, validate), async (c) => {
      const input = c.req.valid("json");
      c.get("signal").throwIfAborted();
      const [task] = await db.insert(tasks).values(input).returning();
      if (!task) throw new Error("insert did not return a task");
      c.get("logger").debug({ task_id: task.id }, "task created");
      c.header("Location", `/api/tasks/${task.id}`);
      return c.json(task, 201);
    })
    .get("/", zValidator("query", listTasks, validate), async (c) => {
      const { limit, offset } = c.req.valid("query");
      c.get("signal").throwIfAborted();
      const rows = await db
        .select()
        .from(tasks)
        .orderBy(asc(tasks.createdAt), asc(tasks.id))
        .limit(limit)
        .offset(offset);
      return c.json(rows);
    })
    .get("/:id", zValidator("param", taskId, validate), async (c) => {
      const { id } = c.req.valid("param");
      c.get("signal").throwIfAborted();
      const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
      if (!task) throw new AppError(404, "not_found", "task not found");
      return c.json(task);
    })
    .patch(
      "/:id",
      zValidator("param", taskId, validate),
      zValidator("json", updateTask, validate),
      async (c) => {
        const { id } = c.req.valid("param");
        const input = c.req.valid("json");
        c.get("signal").throwIfAborted();
        const [task] = await db
          .update(tasks)
          .set({ ...input, updatedAt: sql`now()` })
          .where(eq(tasks.id, id))
          .returning();
        if (!task) throw new AppError(404, "not_found", "task not found");
        c.get("logger").debug({ task_id: id }, "task updated");
        return c.json(task);
      },
    )
    .delete("/:id", zValidator("param", taskId, validate), async (c) => {
      const { id } = c.req.valid("param");
      c.get("signal").throwIfAborted();
      const [deleted] = await db
        .delete(tasks)
        .where(eq(tasks.id, id))
        .returning({ id: tasks.id });
      if (!deleted) throw new AppError(404, "not_found", "task not found");
      c.get("logger").debug({ task_id: id }, "task deleted");
      return c.body(null, 204);
    });
}
