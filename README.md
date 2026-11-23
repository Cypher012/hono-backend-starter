# Hono Backend Starter

A standalone TypeScript API built on Bun and Hono, with Pino logs, Zod request validation, and PostgreSQL access through Drizzle ORM and postgres.js. The starter includes health probes, request deadlines, graceful shutdown, versioned SQL migrations, and a removable Tasks example.

## Run locally

Use Bun 1.4.4 or newer and Docker with Compose. An existing PostgreSQL database works as well. Run commands from this directory.

```sh
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait
bun run db:migrate
bun run dev
```

The API listens on `http://localhost:3000`. Compose publishes PostgreSQL on loopback port 5434. Bun loads `.env` for the API and Drizzle commands. If you use an existing database, set `DATABASE_URL` and skip Compose. Use `bun run start` to run source without watching. `docker compose down` stops PostgreSQL and retains its data.

```sh
curl -i http://localhost:3000/readyz
curl -i http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Ship the starter"}'
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | Required | PostgreSQL URL for the API and Drizzle. Use deployment credentials and appropriate TLS settings in production. |
| `APP_ENV` | `development` | `development`, `production`, or `test`. |
| `HTTP_PORT` | `3000` | Listener port on all interfaces. |
| `LOG_LEVEL` | `info` | Pino level from `trace` through `fatal`, or `silent`. |
| `LOG_FORMAT` | `pretty` in development, `json` otherwise | Pretty logs require the development dependency `pino-pretty`. |
| `APP_NAME` | `hono-backend-starter` | Service name in logs. |
| `APP_VERSION` | `dev` | Version or commit supplied by the deployment. |
| `DB_MAX_CONNS` | `10` | Maximum PostgreSQL connections per process, from 1 to 100. |
| `REQUEST_TIMEOUT_MS` | `30000` | Request deadline in milliseconds, from 1 to 120000. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | HTTP drain budget in milliseconds, from 1 to 120000. |
| `POSTGRES_PORT` | `5434` | Compose host port. If changed, update the database URL too. |

## Database and tests

```sh
bun run db:generate --name=add_projects
bun run db:migrate
bun run db:studio
bun run typecheck
bun run test
```

Edit the schema before generating a migration. Review and commit the generated SQL and its metadata under `drizzle/`. Apply migrations as a deployment step before starting new application instances. Studio runs locally while its command is active.

Unit tests use Hono's in-process request API and run without a database. For integration tests, provision a dedicated test database and set `TEST_DATABASE_URL`:

```sh
TEST_DATABASE_URL='postgres://USER:PASSWORD@HOST:PORT/TEST_DB' bun run test:integration
```

The integration test creates a unique schema, applies the migrations there, runs the Tasks lifecycle, and drops that schema during cleanup. The test role needs permission to create schemas. The integration suite skips when `TEST_DATABASE_URL` is unset. `bun test` discovers both suites.

## Production deployment

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
```

Deploy `dist/`, `package.json`, and `bun.lock` with Bun. The bundle uses external packages. In the runtime directory, install production dependencies and start with the deployment's exported environment.

```sh
bun install --production --frozen-lockfile
# Supply DATABASE_URL and, optionally, APP_VERSION in the deployment environment.
bun run start:prod
```

The production script sets `APP_ENV=production` and disables Bun's automatic env-file loading. Run migrations separately from the full project with development dependencies installed. On SIGINT or SIGTERM, Bun stops accepting connections and drains in-flight HTTP requests for the configured period. Remaining connections are closed on expiry. The PostgreSQL pool then has up to five seconds to close.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| GET | `/healthz` | 200 when the HTTP process is running. |
| GET | `/readyz` | 200 when PostgreSQL responds, 503 when the probe fails or reaches its two-second deadline. A shorter overall request deadline can return 504 first. |
| POST | `/api/tasks` | 201 with the created task and a `Location` header. |
| GET | `/api/tasks` | 200 with tasks ordered by creation time and ID. Optional `limit` defaults to 50 and caps at 100. Optional `offset` defaults to 0. |
| GET | `/api/tasks/:id` | 200 with one task. |
| PATCH | `/api/tasks/:id` | 200 with the updated task. |
| DELETE | `/api/tasks/:id` | 204 with an empty body. |

Task IDs are UUIDs. POST requires a nonblank `title` of up to 200 characters after trimming. `description` is optional, nullable, and capped at 2,000 characters. `completed` defaults to false. PATCH accepts any nonempty subset of those fields. Send writes with `Content-Type: application/json`. Task responses include ISO timestamps as `createdAt` and `updatedAt`. Missing resources return 404, malformed JSON returns 400, schema validation returns 422, and request bodies are limited to 1 MiB.

## Request behavior

- A valid incoming `X-Request-ID` is accepted and echoed. IDs can have up to 64 ASCII letters, digits, hyphens, or underscores. Otherwise the middleware generates a UUID with `crypto.randomUUID()`. Treat these IDs as untrusted correlation metadata.
- Pino creates one child logger per request. Access logs record method, path, status, duration, and request ID once, including for failed requests. They omit request bodies, headers, and query strings. Unexpected errors log stack frames while omitting raw error messages and causes, which can include database connection details or query parameters.
- Errors use `{"error":{"code":"...","message":"...","request_id":"...","fields":{}}}`. The `fields` object is present for validation failures. Use `AppError` with a client-safe message for expected failures. Hono handles thrown errors and unmatched routes centrally.
- Hono sends a 504 when a handler exceeds the request deadline. Use `c.get("signal")` with APIs that accept an `AbortSignal`. The readiness probe passes that signal to postgres.js. Drizzle does not expose per-query signals for this driver, so task handlers check the signal before submitting SQL. Driver query and PostgreSQL statement timeouts bound database work separately. A timed-out response does not guarantee that a write was canceled or rolled back. The HTTP deadline covers handling through response creation, and synchronous JavaScript can delay the timeout.

## Extend or reuse

- `src/index.ts` owns startup, feature registration, and shutdown. `src/app.ts` configures reusable Hono middleware, error handling, and health routes. `src/config/`, `src/db/`, and `src/lib/` hold configuration, pooling and schema, and logging and error helpers.
- For a new module, add the schema in `src/db/schema.ts`, generate a migration, and create a typed Hono subrouter in `src/modules/`. Validate inputs with `zValidator`, use the shared Drizzle instance, and mount the router in `src/index.ts`.
- To remove Tasks, remove its route registration and import in `src/index.ts`, delete `src/modules/tasks/`, and remove the task-specific tests and schema export. In a fresh project, replace the example migration and its metadata when you add your first schema. For an existing database, keep migration history and generate a new migration for any table removal.
- To reuse the starter, copy this directory, change the package name in `package.json` and `APP_NAME` in your environment, then run `bun install` to refresh the lockfile. Choose the new project's database and ports in `.env` and Compose as needed.
