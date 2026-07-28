import type {Env} from "./env.js";

/** A failure that should be reported to the caller verbatim. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(400, code, message, details);
}

/**
 * Cross-origin headers.
 *
 * The API is deliberately open so third parties can integrate directly from their own
 * frontends. There is nothing to protect with an origin check: every request must carry a
 * user signature, and the contract validates it independently.
 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? "*").trim();
  const origin = request.headers.get("Origin");

  let allowOrigin = "*";
  if (allowed !== "*") {
    const list = allowed.split(",").map((entry) => entry.trim());
    allowOrigin = origin && list.includes(origin) ? origin : list[0] ?? "*";
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(
  body: unknown,
  init: {status?: number; headers?: Record<string, string>} = {},
): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });
}

export function errorResponse(
  error: unknown,
  headers: Record<string, string>,
): Response {
  if (error instanceof ApiError) {
    return json(
      {error: {code: error.code, message: error.message, details: error.details ?? null}},
      {status: error.status, headers},
    );
  }

  // Never surface internal messages: they can leak RPC URLs or key material.
  console.error("unhandled error", error);
  return json(
    {error: {code: "internal_error", message: "Something went wrong. Please retry."}},
    {status: 500, headers},
  );
}

/** Parses a JSON body, rejecting anything that is not a plain object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest("invalid_json", "Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("invalid_body", "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
