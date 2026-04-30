import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";

import type { StorageFailure } from "@executor/sdk";

import { RawInvocationError } from "./errors";
import { type HeaderValue, RawFetchResult } from "./types";

type RawFetchArgs = {
  readonly path: string;
  readonly method?: string;
  readonly query?: Record<
    string,
    string | number | boolean | null | readonly (string | number | boolean)[]
  >;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly contentType?: string;
};

const normalizeContentType = (ct: string | null | undefined): string =>
  ct?.split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonContentType = (ct: string | null | undefined): boolean => {
  const normalized = normalizeContentType(ct);
  if (!normalized) return false;
  return (
    normalized === "application/json" ||
    normalized.includes("+json") ||
    normalized.includes("json")
  );
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

export const normalizeMethod = (
  value: unknown,
): HttpMethod => {
  const normalized = String(value ?? "GET").trim().toUpperCase();
  if ((HTTP_METHODS as readonly string[]).includes(normalized)) {
    return normalized as HttpMethod;
  }
  throw new RawInvocationError({
    message: `Unsupported HTTP method: ${normalized}`,
    statusCode: Option.none(),
  });
};

export const requiresApprovalForMethod = (method: string): boolean =>
  method === "POST" ||
  method === "PUT" ||
  method === "PATCH" ||
  method === "DELETE";

export const resolveHeaders = (
  headers: Record<string, HeaderValue>,
  secrets: {
    readonly get: (id: string) => Effect.Effect<string | null, StorageFailure>;
  },
): Effect.Effect<Record<string, string>, RawInvocationError | StorageFailure> => {
  const entries = Object.entries(headers);
  const secretCount = entries.reduce(
    (acc, [, value]) => (typeof value === "string" ? acc : acc + 1),
    0,
  );
  return Effect.gen(function* () {
    const values = yield* Effect.all(
      entries.map(([name, value]) =>
        typeof value === "string"
          ? Effect.succeed({ name, value })
          : secrets.get(value.secretId).pipe(
              Effect.flatMap((secret) =>
                secret === null
                  ? Effect.fail(
                      new RawInvocationError({
                        message: `Failed to resolve secret "${value.secretId}" for header "${name}"`,
                        statusCode: Option.none(),
                      }),
                    )
                  : Effect.succeed({
                      name,
                      value: value.prefix ? `${value.prefix}${secret}` : secret,
                    }),
              ),
            ),
      ),
      { concurrency: "unbounded" },
    );

    const resolved: Record<string, string> = {};
    for (const { name, value } of values) resolved[name] = value;
    return resolved;
  }).pipe(
    Effect.withSpan("plugin.raw.secret.resolve", {
      attributes: {
        "plugin.raw.headers.total": entries.length,
        "plugin.raw.headers.secret_count": secretCount,
      },
    }),
  );
};

const buildBaseUrl = (baseUrl: string): URL => {
  let normalized = baseUrl.trim();
  if (!normalized) {
    throw new RawInvocationError({
      message: "Missing source base URL",
      statusCode: Option.none(),
    });
  }
  if (!normalized.endsWith("/")) normalized = `${normalized}/`;
  try {
    return new URL(normalized);
  } catch (cause) {
    throw new RawInvocationError({
      message: `Invalid source base URL: ${baseUrl}`,
      statusCode: Option.none(),
      cause,
    });
  }
};

export const buildRequestUrl = (
  baseUrl: string,
  inputPath: string,
  query: RawFetchArgs["query"],
): URL => {
  const base = buildBaseUrl(baseUrl);
  const path = inputPath.trim();

  if (!path) {
    throw new RawInvocationError({
      message: "path is required",
      statusCode: Option.none(),
    });
  }
  if (/^https?:\/\//i.test(path)) {
    throw new RawInvocationError({
      message: "raw.fetch path must be relative to the source base URL",
      statusCode: Option.none(),
    });
  }

  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, base);
  const basePrefix = base.pathname;
  const urlPath = url.pathname;

  if (url.origin !== base.origin || !(urlPath === basePrefix.slice(0, -1) || urlPath.startsWith(basePrefix))) {
    throw new RawInvocationError({
      message: `Path "${inputPath}" escapes the configured base URL`,
      statusCode: Option.none(),
    });
  }

  for (const [name, value] of Object.entries(query ?? {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(name, String(item));
      }
      continue;
    }
    url.searchParams.set(name, String(value));
  }

  return url;
};

const requestFor = (
  method: HttpMethod,
  url: string,
): HttpClientRequest.HttpClientRequest => {
  switch (method) {
    case "GET":
      return HttpClientRequest.get(url);
    case "POST":
      return HttpClientRequest.post(url);
    case "PUT":
      return HttpClientRequest.put(url);
    case "PATCH":
      return HttpClientRequest.patch(url);
    case "DELETE":
      return HttpClientRequest.del(url);
    case "HEAD":
      return HttpClientRequest.head(url);
    case "OPTIONS":
      return HttpClientRequest.options(url);
  }
};

const applyHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  headers: Record<string, string>,
): HttpClientRequest.HttpClientRequest => {
  let req = request;
  for (const [name, value] of Object.entries(headers)) {
    req = HttpClientRequest.setHeader(req, name, value);
  }
  return req;
};

const applyBody = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  contentType: string | undefined,
): HttpClientRequest.HttpClientRequest => {
  if (body === undefined) return request;
  if (typeof body === "string") {
    return HttpClientRequest.bodyText(request, body, contentType);
  }

  const resolvedContentType = contentType ?? "application/json";
  let req = HttpClientRequest.bodyUnsafeJson(request, body);
  req = HttpClientRequest.setHeader(req, "content-type", resolvedContentType);
  return req;
};

export const invoke = Effect.fn("Raw.invoke")(function* (
  baseUrl: string,
  args: unknown,
  resolvedHeaders: Record<string, string>,
) {
  const client = yield* HttpClient.HttpClient;
  const input = asRecord(args) as RawFetchArgs;
  const method = normalizeMethod(input.method);
  const url = buildRequestUrl(baseUrl, String(input.path ?? ""), input.query);
  const mergedHeaders = {
    ...resolvedHeaders,
    ...(input.headers ?? {}),
  };

  yield* Effect.annotateCurrentSpan({
    "http.method": method,
    "http.url": url.toString(),
    "plugin.raw.base_url": baseUrl,
    "plugin.raw.headers.resolved_count": Object.keys(resolvedHeaders).length,
  });

  let request = requestFor(method, url.toString());
  request = applyHeaders(request, mergedHeaders);
  request = applyBody(request, input.body, input.contentType);

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new RawInvocationError({
          message: `HTTP request failed: ${err.message}`,
          statusCode: Option.none(),
          cause: err,
        }),
    ),
  );

  const headers = Object.fromEntries(Object.entries(response.headers));
  const contentType = response.headers["content-type"] ?? null;
  const rawBody = yield* response.text.pipe(
    Effect.mapError(
      (err) =>
        new RawInvocationError({
          message: `Failed to read response body: ${err.message}`,
          statusCode: Option.none(),
          cause: err,
        }),
    ),
  );
  const body: unknown = isJsonContentType(contentType)
    ? yield* Effect.try({
        try: () => JSON.parse(rawBody),
        catch: () => rawBody,
      })
    : rawBody;

  return new RawFetchResult({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers,
    body,
  });
});

export const invokeWithLayer = (
  baseUrl: string,
  args: unknown,
  resolvedHeaders: Record<string, string>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
) =>
  invoke(baseUrl, args, resolvedHeaders).pipe(
    Effect.provide(httpClientLayer),
    Effect.withSpan("plugin.raw.invoke", {
      attributes: {
        "plugin.raw.base_url": baseUrl,
      },
    }),
  );
