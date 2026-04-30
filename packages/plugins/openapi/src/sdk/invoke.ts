import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";

import type { SecretOwnedByConnectionError, StorageFailure } from "@executor/sdk";

import { OpenApiInvocationError } from "./errors";
import {
  type EncodingObject,
  type HeaderValue,
  type OperationBinding,
  InvocationResult,
  type MediaBinding,
  type OperationParameter,
} from "./types";

export interface PreparedInvocationRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "TRACE";
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
    readonly get: (
      id: string,
    ) => Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure>;
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
              Effect.mapError((err) =>
                "_tag" in err && err._tag === "SecretOwnedByConnectionError"
                  ? new OpenApiInvocationError({
                      message: `Failed to resolve secret "${value.secretId}" for header "${name}"`,
                      statusCode: Option.none(),
                    })
                  : err,
              ),
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

const toUint8Array = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    return new Uint8Array(value as readonly number[]);
  }
  return null;
};

type FormDataRecord = Parameters<typeof HttpClientRequest.bodyFormDataRecord>[1];
type FormDataCoercible = FormDataRecord[string];

// Pull a plain ArrayBuffer out of a Uint8Array — `new Blob([u8])` rejects
// views whose `.buffer` is `SharedArrayBuffer | ArrayBuffer` under strict
// lib.dom typings.
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

// ---------------------------------------------------------------------------
// OpenAPI 3.x encoding — per-property style/explode/allowReserved/contentType
// for multipart/form-data and application/x-www-form-urlencoded bodies.
// Spec ref: https://spec.openapis.org/oas/v3.1.0#encoding-object
// ---------------------------------------------------------------------------

type StyleExplode = {
  readonly style: string;
  readonly explode: boolean;
  readonly allowReserved: boolean;
};

const DEFAULT_FORM_STYLE: StyleExplode = {
  style: "form",
  explode: true,
  allowReserved: false,
};

const resolveStyleExplode = (e: EncodingObject | undefined): StyleExplode => {
  if (!e) return DEFAULT_FORM_STYLE;
  return {
    style: Option.getOrElse(e.style, () => DEFAULT_FORM_STYLE.style),
    explode: Option.getOrElse(e.explode, () => DEFAULT_FORM_STYLE.explode),
    allowReserved: Option.getOrElse(e.allowReserved, () => DEFAULT_FORM_STYLE.allowReserved),
  };
};

// RFC 3986 §2.2 reserved chars. `allowReserved: true` leaves these
// unencoded; default OAS behavior encodes everything non-unreserved.
const RESERVED_UNENCODED_RE = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/;

const encodeFormValue = (v: unknown, allowReserved: boolean): string => {
  const raw = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  if (!allowReserved) return encodeURIComponent(raw);
  // Walk char-by-char so the reserved set passes through as-is.
  let out = "";
  for (const ch of raw) {
    out += RESERVED_UNENCODED_RE.test(ch) ? ch : encodeURIComponent(ch);
  }
  return out;
};

/**
 * Serialize a record to application/x-www-form-urlencoded with OAS3 style
 * rules honored per-field. Supports `form` (default), `deepObject`,
 * `pipeDelimited`, `spaceDelimited` styles with `explode` true / false.
 */
const serializeFormUrlEncoded = (
  value: Record<string, unknown>,
  encoding: Record<string, EncodingObject> | undefined,
): string => {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    const { style, explode, allowReserved } = resolveStyleExplode(encoding?.[key]);
    const encKey = encodeURIComponent(key);

    if (Array.isArray(raw)) {
      if (explode) {
        for (const v of raw) {
          parts.push(`${encKey}=${encodeFormValue(v, allowReserved)}`);
        }
      } else {
        const sep =
          style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
        parts.push(
          `${encKey}=${encodeFormValue(
            raw.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(sep),
            allowReserved,
          )}`,
        );
      }
      continue;
    }

    if (typeof raw === "object") {
      const entries = Object.entries(raw as Record<string, unknown>).filter(
        ([, v]) => v !== undefined && v !== null,
      );
      if (style === "deepObject") {
        for (const [subkey, subval] of entries) {
          // Encode the whole `key[subkey]` fragment so `[` / `]` become
          // `%5B` / `%5D`. Matches swagger-client's behaviour and remains
          // accepted by common server-side parsers (qs, Rails, etc.).
          parts.push(
            `${encodeURIComponent(`${key}[${subkey}]`)}=${encodeFormValue(
              subval,
              allowReserved,
            )}`,
          );
        }
      } else if (explode) {
        // form + explode=true on object: sub-keys become top-level fields.
        for (const [subkey, subval] of entries) {
          parts.push(
            `${encodeURIComponent(subkey)}=${encodeFormValue(subval, allowReserved)}`,
          );
        }
      } else {
        // form + explode=false on object: flatten to csv key,val,key,val.
        const flat = entries.flatMap(([k, v]) => [
          k,
          typeof v === "object" ? JSON.stringify(v) : String(v),
        ]);
        parts.push(`${encKey}=${encodeFormValue(flat.join(","), allowReserved)}`);
      }
      continue;
    }

    parts.push(`${encKey}=${encodeFormValue(raw, allowReserved)}`);
  }
  return parts.join("&");
};

/**
 * Best-effort build of a multipart FormData entry record.
 *
 * If `encoding[key].contentType` is declared (OAS3 §4.8.15), wrap the value
 * in a `Blob` with that type so the runtime multipart framer emits the
 * per-part `Content-Type` header (e.g. `application/json` for a metadata
 * part whose server expects parsed JSON).
 *
 * Otherwise: primitives pass through, arrays handle their item types, byte
 * shapes wrap as Blob, nested objects JSON-stringify (never `[object Object]`).
 */
const coerceFormDataRecord = (
  value: Record<string, unknown>,
  encoding: Record<string, EncodingObject> | undefined,
): FormDataRecord => {
  const out: Record<string, FormDataCoercible> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;

    const partType = encoding?.[key]
      ? Option.getOrUndefined(encoding[key]!.contentType)
      : undefined;

    // Explicit per-part content type: wrap in a typed Blob so the framer
    // emits `Content-Type: <partType>` on this part. JSON types get the
    // value JSON-stringified first so the blob body is valid JSON.
    if (partType) {
      const isJson =
        partType.startsWith("application/json") || partType.includes("+json");
      const serialized =
        typeof raw === "string"
          ? raw
          : isJson
            ? JSON.stringify(raw)
            : typeof raw === "object"
              ? JSON.stringify(raw)
              : String(raw);
      out[key] = new Blob([serialized], { type: partType });
      continue;
    }

    if (
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      raw instanceof Blob ||
      (typeof File !== "undefined" && raw instanceof File)
    ) {
      out[key] = raw as FormDataCoercible;
      continue;
    }
    if (Array.isArray(raw)) {
      out[key] = raw.map((v) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        v instanceof Blob ||
        (typeof File !== "undefined" && v instanceof File)
          ? (v as FormDataCoercible)
          : JSON.stringify(v),
      ) as FormDataCoercible;
      continue;
    }
    const bytes = toUint8Array(raw);
    if (bytes) {
      out[key] = new Blob([toArrayBuffer(bytes)]);
      continue;
    }
    out[key] = JSON.stringify(raw);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Request body dispatch
//
// Dispatch is driven by the spec-declared content type first, JS type of
// the provided body second. Servers that advertise a specific content type
// almost always reject anything else (e.g. a multipart endpoint will hang
// waiting for valid framing if it receives `application/json`), so the
// content type wins.
//
// Within each content type we accept both pre-serialized strings (user
// already produced the wire format) and structured JS values we can
// serialize ourselves. The last-resort fallback is `JSON.stringify(body)`
// — never `String(body)` (which produces the useless `[object Object]`).
// ---------------------------------------------------------------------------

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
      const contentsOpt = Option.getOrUndefined(rb.contents);
      const requestedCt =
        typeof args.contentType === "string" ? args.contentType : undefined;
      const selected: MediaBinding | undefined =
        contentsOpt && requestedCt
          ? contentsOpt.find((c) => c.contentType === requestedCt)
          : undefined;
      const defaultMedia = contentsOpt?.[0];
      const chosenCt = selected?.contentType ?? defaultMedia?.contentType ?? rb.contentType;
      const chosenEncoding = selected
        ? Option.getOrUndefined(selected.encoding)
        : defaultMedia
          ? Option.getOrUndefined(defaultMedia.encoding)
          : undefined;

      bodyContentType = chosenCt;
      if (isJsonContentType(chosenCt)) {
        bodyKind = "json";
        bodyValue = inputBody;
      } else if (isFormUrlEncoded(chosenCt)) {
        bodyKind = "urlencoded";
        bodyValue =
          typeof inputBody === "string"
            ? inputBody
            : typeof inputBody === "object" && inputBody !== null && !Array.isArray(inputBody)
              ? serializeFormUrlEncoded(inputBody as Record<string, unknown>, chosenEncoding)
              : String(inputBody);
      } else if (isMultipartFormData(chosenCt)) {
        bodyKind = "multipart";
        bodyValue =
          inputBody instanceof FormData
            ? inputBody
            : typeof inputBody === "object" && inputBody !== null
              ? coerceFormDataRecord(inputBody as Record<string, unknown>, chosenEncoding)
              : inputBody;
      } else if (typeof inputBody === "string") {
        bodyKind = "text";
        bodyValue = inputBody;
      } else {
        const bytes = toUint8Array(inputBody);
        bodyKind = "text";
        bodyValue = bytes ? Array.from(bytes) : JSON.stringify(inputBody);
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
      return typeof prepared.bodyValue === "string"
        ? HttpClientRequest.bodyText(
            request,
            prepared.bodyValue,
            prepared.bodyContentType ?? undefined,
          )
        : HttpClientRequest.bodyUnsafeJson(request, prepared.bodyValue);
    case "text":
    case "urlencoded":
      return HttpClientRequest.bodyText(
        request,
        String(prepared.bodyValue ?? ""),
        prepared.bodyContentType ?? undefined,
      );
    case "multipart":
      return prepared.bodyValue instanceof FormData
        ? HttpClientRequest.bodyFormData(request, prepared.bodyValue)
        : HttpClientRequest.bodyFormDataRecord(
            request,
            prepared.bodyValue as Parameters<typeof HttpClientRequest.bodyFormDataRecord>[1],
          );
  }
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

  let request = HttpClientRequest.make(prepared.method as "GET")(prepared.path);

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

  return baseUrl
    ? url.toString().replace("http://openapi.local", "")
    : `${url.pathname}${url.search}`;
};

export const buildManagedHttpRequest = Effect.fn("OpenApi.buildManagedHttpRequest")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  baseUrl: string,
  resolvedHeaders: Record<string, string>,
) {
  const prepared = yield* prepareRequest(operation, args, resolvedHeaders);
  if (prepared.bodyKind === "multipart") {
    return yield* new OpenApiInvocationError({
      message: "Multipart form-data requests are not implemented for managed auth yet.",
      statusCode: Option.none(),
    });
  }

  const parameters: Array<{ name: string; value: string; type: "header" | "query" }> = [];
  for (const [name, value] of Object.entries(prepared.headers)) {
    parameters.push({ name, value, type: "header" });
  }
  if (
    prepared.bodyKind !== "none" &&
    prepared.bodyContentType &&
    !Object.keys(prepared.headers).some((name) => name.toLowerCase() === "content-type")
  ) {
    parameters.push({ name: "content-type", value: prepared.bodyContentType, type: "header" });
  }

  const method = prepared.method;
  if (method === "OPTIONS" || method === "TRACE") {
    return yield* new OpenApiInvocationError({
      message: `Managed auth does not support ${method} requests`,
      statusCode: Option.none(),
    });
  }

  return {
    endpoint: buildInvocationEndpoint(baseUrl, prepared),
    method: method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD",
    ...(prepared.bodyKind !== "none" ? { body: prepared.bodyValue } : {}),
    parameters,
  };
});

// ---------------------------------------------------------------------------
// Derive annotations from HTTP method
// ---------------------------------------------------------------------------

const REQUIRE_APPROVAL = new Set(["post", "put", "patch", "delete"]);

export const annotationsForOperation = (
  method: string,
  pathTemplate: string,
): { requiresApproval?: boolean; approvalDescription?: string } => {
  const m = method.toLowerCase();
  if (!REQUIRE_APPROVAL.has(m)) return {};
  return {
    requiresApproval: true,
    approvalDescription: `${method.toUpperCase()} ${pathTemplate}`,
  };
};
