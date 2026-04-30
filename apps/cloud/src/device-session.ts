import { DurableObject } from "cloudflare:workers";

type DeviceRecord = {
  readonly deviceId: string;
  readonly name: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly userId: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly connectedAt: number;
  readonly lastSeenAt: number;
  readonly online: boolean;
};

type DeviceSessionEnv = Env;

const DEVICE_KEY_PREFIX = "device:";
const ACTIVE_DEVICE_KEY = "active-device-id";
const DEVICE_STALE_MS = 75_000;
const DEVICE_RPC_TIMEOUT_MS = 5 * 60_000;
const INTERNAL_USER_ID_HEADER = "x-godtool-device-user-id";
const INTERNAL_ORGANIZATION_ID_HEADER = "x-godtool-device-organization-id";
const INTERNAL_ORGANIZATION_NAME_HEADER = "x-godtool-device-organization-name";

type ExecuteRequestBody = {
  readonly code?: unknown;
};

type DeviceRpcResponse =
  | {
      readonly type: "execute.response";
      readonly requestId: string;
      readonly status: "completed";
      readonly result: unknown;
    }
  | {
      readonly type: "execute.response";
      readonly requestId: string;
      readonly status: "error";
      readonly error: string;
    };

type PendingRequest = {
  readonly deviceId: string;
  readonly resolve: (message: DeviceRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const sanitizeText = (value: string | null, fallback: string): string => {
  const text = value?.trim();
  if (!text) return fallback;
  return text.slice(0, 160);
};

export class DeviceSessionDO extends DurableObject<DeviceSessionEnv> {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingRequest>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      return this.handleConnect(request, url);
    }

    if (url.pathname === "/status") {
      return this.status();
    }

    if (url.pathname === "/execute") {
      return this.handleExecute(request);
    }

    return json({ error: "not_found" }, { status: 404 });
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "expected_websocket" }, { status: 426 });
    }

    const userId = request.headers.get(INTERNAL_USER_ID_HEADER);
    const organizationId = request.headers.get(INTERNAL_ORGANIZATION_ID_HEADER);
    const organizationName = request.headers.get(INTERNAL_ORGANIZATION_NAME_HEADER);
    if (!userId || !organizationId || !organizationName) {
      return json({ error: "unauthorized" }, { status: 401 });
    }

    const deviceId = sanitizeText(url.searchParams.get("deviceId"), crypto.randomUUID());
    const name = sanitizeText(url.searchParams.get("name"), "Desktop");
    const platform = sanitizeText(url.searchParams.get("platform"), "unknown");
    const appVersion = sanitizeText(url.searchParams.get("appVersion"), "unknown");
    const now = Date.now();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    this.sockets.get(deviceId)?.close(1000, "replaced");
    this.sockets.set(deviceId, server);

    await this.saveDevice({
      deviceId,
      name,
      organizationId,
      organizationName,
      userId,
      platform,
      appVersion,
      connectedAt: now,
      lastSeenAt: now,
      online: true,
    });
    await this.ctx.storage.put(ACTIVE_DEVICE_KEY, deviceId);

    server.send(
      JSON.stringify({
        type: "connected",
        deviceId,
        organizationId,
        active: true,
      }),
    );

    server.addEventListener("message", (event) => {
      void this.handleMessage(deviceId, server, event.data);
    });
    server.addEventListener("close", () => {
      void this.markOffline(deviceId, server);
    });
    server.addEventListener("error", () => {
      void this.markOffline(deviceId, server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "godtool-device" },
    });
  }

  private async status(): Promise<Response> {
    const now = Date.now();
    const stored = await this.ctx.storage.list<DeviceRecord>({ prefix: DEVICE_KEY_PREFIX });
    const devices = Array.from(stored.values())
      .map((device) => ({
        ...device,
        online:
          this.sockets.has(device.deviceId) ||
          (device.online && now - device.lastSeenAt < DEVICE_STALE_MS),
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    return json({
      activeDeviceId: (await this.ctx.storage.get<string>(ACTIVE_DEVICE_KEY)) ?? null,
      devices,
    });
  }

  private async handleExecute(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }

    const userId = request.headers.get(INTERNAL_USER_ID_HEADER);
    const organizationId = request.headers.get(INTERNAL_ORGANIZATION_ID_HEADER);
    const organizationName = request.headers.get(INTERNAL_ORGANIZATION_NAME_HEADER);
    if (!userId || !organizationId || !organizationName) {
      return json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as ExecuteRequestBody | null;
    if (!body || typeof body.code !== "string") {
      return json({ error: "invalid_request" }, { status: 400 });
    }

    const activeDeviceId = await this.resolveActiveSocketDeviceId();
    if (!activeDeviceId) {
      return json({ error: "no_connected_device" }, { status: 409 });
    }

    const socket = this.sockets.get(activeDeviceId);
    if (!socket) {
      return json({ error: "no_connected_device" }, { status: 409 });
    }

    const requestId = crypto.randomUUID();
    try {
      const response = await this.sendRpc(activeDeviceId, socket, {
        type: "execute.request",
        requestId,
        code: body.code,
      });

      if (response.status === "error") {
        return json({ status: "error", error: response.error }, { status: 502 });
      }

      return json({ status: "completed", result: response.result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === "no_connected_device" ? 409 : 504;
      return json({ error: message }, { status });
    }
  }

  private async resolveActiveSocketDeviceId(): Promise<string | null> {
    const activeDeviceId = await this.ctx.storage.get<string>(ACTIVE_DEVICE_KEY);
    if (activeDeviceId && this.sockets.has(activeDeviceId)) return activeDeviceId;

    const first = this.sockets.keys().next();
    return first.done ? null : first.value;
  }

  private sendRpc(
    deviceId: string,
    socket: WebSocket,
    payload: unknown,
  ): Promise<DeviceRpcResponse> {
    if (socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("no_connected_device"));
    }

    const requestId =
      typeof payload === "object" &&
      payload !== null &&
      "requestId" in payload &&
      typeof payload.requestId === "string"
        ? payload.requestId
        : crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("device_rpc_timeout"));
      }, DEVICE_RPC_TIMEOUT_MS);

      this.pending.set(requestId, { deviceId, resolve, reject, timeout });

      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handleMessage(
    deviceId: string,
    socket: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    const device = await this.ctx.storage.get<DeviceRecord>(this.deviceKey(deviceId));
    if (!device) return;

    const next = { ...device, lastSeenAt: Date.now(), online: true };
    await this.saveDevice(next);

    if (typeof data !== "string") return;
    try {
      const message = JSON.parse(data) as { type?: string };
      if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
        return;
      }

      if (message.type === "execute.response") {
        this.resolvePending(deviceId, message);
      }
    } catch {
      // Non-JSON frames are ignored.
    }
  }

  private resolvePending(deviceId: string, message: { readonly type?: string }): void {
    const response = this.parseRpcResponse(message);
    if (!response) return;

    const pending = this.pending.get(response.requestId);
    if (!pending || pending.deviceId !== deviceId) return;

    clearTimeout(pending.timeout);
    this.pending.delete(response.requestId);
    pending.resolve(response);
  }

  private parseRpcResponse(message: { readonly type?: string }): DeviceRpcResponse | null {
    if (
      message.type !== "execute.response" ||
      !("requestId" in message) ||
      typeof message.requestId !== "string" ||
      !("status" in message)
    ) {
      return null;
    }

    if (message.status === "completed" && "result" in message) {
      return {
        type: "execute.response",
        requestId: message.requestId,
        status: "completed",
        result: message.result,
      };
    }

    if (message.status === "error") {
      const error =
        "error" in message && typeof message.error === "string"
          ? message.error
          : "Desktop execution failed";
      return {
        type: "execute.response",
        requestId: message.requestId,
        status: "error",
        error,
      };
    }

    return null;
  }

  private async markOffline(deviceId: string, socket: WebSocket): Promise<void> {
    if (this.sockets.get(deviceId) !== socket) return;
    this.sockets.delete(deviceId);
    this.rejectPendingForDevice(deviceId, new Error("device_disconnected"));

    const device = await this.ctx.storage.get<DeviceRecord>(this.deviceKey(deviceId));
    if (!device) return;
    await this.saveDevice({ ...device, online: false, lastSeenAt: Date.now() });
  }

  private rejectPendingForDevice(deviceId: string, error: Error): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }

  private saveDevice(device: DeviceRecord): Promise<void> {
    return this.ctx.storage.put(this.deviceKey(device.deviceId), device);
  }

  private deviceKey(deviceId: string): string {
    return `${DEVICE_KEY_PREFIX}${deviceId}`;
  }
}
