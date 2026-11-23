import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../middleware/request";

export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorResponse(c: Context<AppEnv>, error: AppError) {
  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        request_id: c.get("requestId"),
        fields: error.fields,
      },
    },
    error.status,
  );
}

const httpErrors: Partial<Record<ContentfulStatusCode, [string, string]>> = {
  400: ["bad_request", "invalid request body"],
  401: ["unauthenticated", "unauthenticated"],
  403: ["forbidden", "forbidden"],
  404: ["not_found", "not found"],
  409: ["conflict", "conflict"],
  422: ["invalid_input", "invalid input"],
  503: ["unavailable", "database unavailable"],
  504: ["timeout", "request timed out"],
};

export function handleError(error: Error, c: Context<AppEnv>) {
  const aborted: unknown = c.get("signal")?.reason;
  if (
    aborted instanceof HTTPException &&
    (aborted.status === 503 || aborted.status === 504)
  ) {
    error = aborted;
  }
  if (error instanceof AppError) return errorResponse(c, error);
  if (isDatabaseTimeout(error)) {
    return errorResponse(c, new AppError(504, "timeout", "request timed out"));
  }
  if (error instanceof HTTPException) {
    const publicError = httpErrors[error.status];
    if (publicError)
      return errorResponse(c, new AppError(error.status, ...publicError));
    if (error.status < 500) {
      return errorResponse(
        c,
        new AppError(error.status, "http_error", "request failed"),
      );
    }
  }

  c.get("logger").error({ err: error }, "request failed");
  return errorResponse(
    c,
    new AppError(500, "internal", "internal server error"),
  );
}

function isDatabaseTimeout(error: Error) {
  // Drizzle wraps driver errors as the cause of the query error.
  const cause: unknown = error.cause ?? error;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause.code === "QUERY_TIMEOUT" || cause.code === "57014")
  );
}
