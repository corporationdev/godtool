import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";

import type { StorageFailure } from "@executor/sdk";

import { OpenApiInvocationError } from "./errors";
import {
  type HeaderValue,
  type OperationBinding,
  InvocationResult,
  type OperationParameter,
} from "./types";

export interface PreparedInvocationRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  readonly path: string;
  readonly queryParams: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly headers: Record<string, string>;
  readonly bodyKind: "none" | "json" | "text" | "urlencoded" | "multipart";
  readonly bodyValue?: unknown;
  readonly bodyContentType: string | null;
}

// ---------------------------------------------------------------------------
// Parameter reading
// ---------------------------------------------------------------------------

const CONTAINER_KEYS: Record<string, readonly string[]> = {
  path: ["path", "pathParams", "params"],
  query: ["query", "queryParams", "params"],
  header: ["headers", "header"],
  cookie: ["cookies", "cookie"],
};

const readParamValue = (args: Record<string, unknown>, param: OperationParameter): unknown => {
  const direct = args[param.name];
  if (direct !== undefined) return direct;

  for (const key of CONTAINER_KEYS[param.location] ?? []) {
    const container = args[key];
    if (typeof container === "object" && container !== null && !Array.isArray(container)) {
      const nested = (container as Record<string, unknown>)[param.name];
      if (nested !== undefined) return nested;
    }
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const resolvePath = Effect.fn("OpenApi.resolvePath")(function* (
  pathTemplate: string,
  args: Record<string, unknown>,
  parameters: readonly OperationParameter[],
) {
  let resolved = pathTemplate;

  for (const param of parameters) {
    if (param.location !== "path") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) {
      if (param.required) {
        return yield* new OpenApiInvocationError({
          message: `Missing required path parameter: ${param.name}`,
          statusCode: Option.none(),
        });
      }
      continue;
    }
    resolved = resolved.replaceAll(`{${param.name}}`, encodeURIComponent(String(value)));
  }

  const remaining = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  for (const name of remaining) {
    const value = args[name];
    if (value !== undefined && value !== null) {
      resolved = resolved.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    }
  }

  const unresolved = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  if (unresolved.length > 0) {
    return yield* new OpenApiInvocationError({
      message: `Unresolved path parameters: ${[...new Set(unresolved)].join(", ")}`,
      statusCode: Option.none(),
    });
  }

  return resolved;
});

// ---------------------------------------------------------------------------
// Header resolution — resolves secret refs at invocation time
// ---------------------------------------------------------------------------

export const resolveHeaders = (
  headers: Record<string, HeaderValue>,
  secrets: {
    readonly get: (id: string) => Effect.Effect<string | null, StorageFailure>;
  },
): Effect.Effect<Record<string, string>, OpenApiInvocationError | StorageFailure> => {
  const entries = Object.entries(headers);
  const secretCount = entries.reduce(
    (acc, [, value]) => (typeof value === "string" ? acc : acc + 1),
    0,
  );
  return Effect.gen(function* () {
    // Fan out secret lookups: on every invocation, one or two headers
    // typically each hit the secret store. Resolving them in parallel
    // is a free wall-clock win — preserved order is only needed for
    // the final assembly, not the fetches.
    const values = yield* Effect.all(
      entries.map(([name, value]) =>
        typeof value === "string"
          ? Effect.succeed({ name, value })
          : secrets.get(value.secretId).pipe(
              Effect.flatMap((secret) =>
                secret === null
                  ? Effect.fail(
                      new OpenApiInvocationError({
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
    Effect.withSpan("plugin.openapi.secret.resolve", {
      attributes: {
        "plugin.openapi.headers.total": entries.length,
        "plugin.openapi.headers.secret_count": secretCount,
      },
    }),
  );
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

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const normalizeContentType = (ct: string | null | undefined): string =>
  ct?.split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonContentType = (ct: string | null | undefined): boolean => {
  const normalized = normalizeContentType(ct);
  if (!normalized) return false;
  return (
    normalized === "application/json" || normalized.includes("+json") || normalized.includes("json")
  );
};

const isFormUrlEncoded = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct) === "application/x-www-form-urlencoded";

const isMultipartFormData = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct).startsWith("multipart/form-data");

const prepareRequest = Effect.fn("OpenApi.prepareRequest")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
) {
  const resolvedPath = yield* resolvePath(operation.pathTemplate, args, operation.parameters);
  const path = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;

  const queryParams: Array<{ readonly name: string; readonly value: string }> = [];
  for (const param of operation.parameters) {
    if (param.location !== "query") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    queryParams.push({ name: param.name, value: String(value) });
  }

  const headers: Record<string, string> = { ...resolvedHeaders };
  for (const param of operation.parameters) {
    if (param.location !== "header") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    headers[param.name] = String(value);
  }

  let bodyKind: PreparedInvocationRequest["bodyKind"] = "none";
  let bodyValue: unknown = undefined;
  let bodyContentType: string | null = null;

  if (Option.isSome(operation.requestBody)) {
    const rb = operation.requestBody.value;
    const inputBody = args.body ?? args.input;
    if (inputBody !== undefined) {
      bodyContentType = rb.contentType;
      if (isJsonContentType(rb.contentType)) {
        bodyKind = "json";
        bodyValue = inputBody;
      } else if (typeof inputBody === "string") {
        bodyKind = "text";
        bodyValue = inputBody;
      } else if (isFormUrlEncoded(rb.contentType)) {
        bodyKind = "urlencoded";
        bodyValue = inputBody;
      } else if (isMultipartFormData(rb.contentType)) {
        bodyKind = "multipart";
        bodyValue = inputBody;
      } else {
        bodyKind = "text";
        bodyValue = JSON.stringify(inputBody);
      }
    }
  }

  return {
    method: operation.method.toUpperCase() as PreparedInvocationRequest["method"],
    path,
    queryParams,
    headers,
    bodyKind,
    bodyValue,
    bodyContentType,
  } satisfies PreparedInvocationRequest;
});

const applyPreparedBody = (
  request: HttpClientRequest.HttpClientRequest,
  prepared: PreparedInvocationRequest,
): HttpClientRequest.HttpClientRequest => {
  switch (prepared.bodyKind) {
    case "none":
      return request;
    case "json":
      return HttpClientRequest.bodyUnsafeJson(request, prepared.bodyValue);
    case "text":
      return HttpClientRequest.bodyText(
        request,
        String(prepared.bodyValue ?? ""),
        prepared.bodyContentType ?? undefined,
      );
    case "urlencoded":
      return HttpClientRequest.bodyUrlParams(
        request,
        prepared.bodyValue as Parameters<typeof HttpClientRequest.bodyUrlParams>[1],
      );
    case "multipart":
      return HttpClientRequest.bodyFormDataRecord(
        request,
        prepared.bodyValue as Parameters<typeof HttpClientRequest.bodyFormDataRecord>[1],
      );
  }
};

export const buildInvocationEndpoint = (
  baseUrl: string,
  prepared: Pick<PreparedInvocationRequest, "path" | "queryParams">,
): string => {
  const pathWithBase = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}${prepared.path.startsWith("/") ? prepared.path : `/${prepared.path}`}`
    : prepared.path;

  if (prepared.queryParams.length === 0) return pathWithBase;

  const url = new URL(pathWithBase, "http://openapi.local");
  for (const param of prepared.queryParams) {
    url.searchParams.append(param.name, param.value);
  }

  return baseUrl ? url.toString().replace("http://openapi.local", "") : `${url.pathname}${url.search}`;
};

// ---------------------------------------------------------------------------
// Public API — invoke a single operation
// ---------------------------------------------------------------------------

export const invoke = Effect.fn("OpenApi.invoke")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
) {
  const client = yield* HttpClient.HttpClient;

  yield* Effect.annotateCurrentSpan({
    "http.method": operation.method.toUpperCase(),
    "http.route": operation.pathTemplate,
    "plugin.openapi.method": operation.method.toUpperCase(),
    "plugin.openapi.path_template": operation.pathTemplate,
    "plugin.openapi.headers.resolved_count": Object.keys(resolvedHeaders).length,
  });

  const prepared = yield* prepareRequest(operation, args, resolvedHeaders);

  let request = HttpClientRequest.make(prepared.method)(prepared.path);

  for (const param of prepared.queryParams) {
    request = HttpClientRequest.setUrlParam(request, param.name, param.value);
  }

  request = applyHeaders(request, prepared.headers);
  request = applyPreparedBody(request, prepared);

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new OpenApiInvocationError({
          message: `HTTP request failed: ${err.message}`,
          statusCode: Option.none(),
          cause: err,
        }),
    ),
  );

  const status = response.status;
  yield* Effect.annotateCurrentSpan({
    "http.status_code": status,
  });
  const responseHeaders: Record<string, string> = { ...response.headers };

  const contentType = response.headers["content-type"] ?? null;
  const mapBodyError = Effect.mapError(
    (err: { readonly message?: string }) =>
      new OpenApiInvocationError({
        message: `Failed to read response body: ${err.message ?? String(err)}`,
        statusCode: Option.some(status),
        cause: err,
      }),
  );
  const responseBody: unknown =
    status === 204
      ? null
      : isJsonContentType(contentType)
        ? yield* response.json.pipe(
            Effect.catchAll(() => response.text),
            mapBodyError,
          )
        : yield* response.text.pipe(mapBodyError);

  const ok = status >= 200 && status < 300;

  return new InvocationResult({
    status,
    headers: responseHeaders,
    data: ok ? responseBody : null,
    error: ok ? null : responseBody,
  });
});

// ---------------------------------------------------------------------------
// Invoke with a provided HttpClient layer + optional baseUrl prefix
// ---------------------------------------------------------------------------

export const invokeWithLayer = (
  operation: OperationBinding,
  args: Record<string, unknown>,
  baseUrl: string,
  resolvedHeaders: Record<string, string>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
) => {
  const clientWithBaseUrl = baseUrl
    ? Layer.effect(
        HttpClient.HttpClient,
        Effect.map(
          HttpClient.HttpClient,
          HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
        ),
      ).pipe(Layer.provide(httpClientLayer))
    : httpClientLayer;

  return invoke(operation, args, resolvedHeaders).pipe(
    Effect.provide(clientWithBaseUrl),
    Effect.withSpan("plugin.openapi.invoke", {
      attributes: {
        "plugin.openapi.method": operation.method.toUpperCase(),
        "plugin.openapi.path_template": operation.pathTemplate,
        "plugin.openapi.base_url": baseUrl,
      },
    }),
  );
};

export const prepareInvocationRequest = (
  operation: OperationBinding,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
) => prepareRequest(operation, args, resolvedHeaders);

// ---------------------------------------------------------------------------
// Derive annotations from HTTP method
// ---------------------------------------------------------------------------

const DEFAULT_REQUIRE_APPROVAL = new Set(["post", "put", "patch", "delete"]);

export const annotationsForOperation = (
  method: string,
  pathTemplate: string,
  policy?: { readonly requireApprovalFor?: readonly string[] },
): { requiresApproval?: boolean; approvalDescription?: string } => {
  const m = method.toLowerCase();
  const requireSet = policy?.requireApprovalFor
    ? new Set(policy.requireApprovalFor.map((v) => v.toLowerCase()))
    : DEFAULT_REQUIRE_APPROVAL;
  if (!requireSet.has(m)) return {};
  return {
    requiresApproval: true,
    approvalDescription: `${method.toUpperCase()} ${pathTemplate}`,
  };
};
