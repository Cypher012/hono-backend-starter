import { z } from "zod";

const databaseUrl = z.string().trim().pipe(
  z.url({ protocol: /^postgres(?:ql)?$/, hostname: /.+/, error: "expected a PostgreSQL URL with a host" }),
);

const envSchema = z.object({
  DATABASE_URL: databaseUrl,
  APP_ENV: z.enum(["development", "production", "test"]).default("development"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  LOG_FORMAT: z.enum(["json", "pretty"]).optional(),
  APP_NAME: z.string().trim().min(1).default("hono-backend-starter"),
  APP_VERSION: z.string().trim().min(1).default("dev"),
  DB_MAX_CONNS: z.coerce.number().int().min(1).max(100).default(10),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(30_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
});

export class ConfigError extends Error {
  constructor(fields: readonly string[]) {
    super(`Invalid configuration\n  ${fields.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

function parse<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  return result.data;
}

export function loadConfig(env = Bun.env) {
  const config = parse(envSchema, env);
  return {
    ...config,
    LOG_FORMAT: config.LOG_FORMAT ?? (config.APP_ENV === "development" ? "pretty" : "json"),
  };
}

export function loadDatabaseUrl(env = Bun.env) {
  return parse(envSchema.pick({ DATABASE_URL: true }), env).DATABASE_URL;
}

export type Config = ReturnType<typeof loadConfig>;
