import { index, pgTable, timestamp, uuid, varchar, boolean } from "drizzle-orm/pg-core";

export const tasks = pgTable("tasks", {
  id: uuid().primaryKey().defaultRandom(),
  title: varchar({ length: 200 }).notNull(),
  description: varchar({ length: 2000 }),
  completed: boolean().notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("tasks_created_at_id_idx").on(table.createdAt, table.id),
]);
