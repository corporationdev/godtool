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
const ACTIVE_DEVICE_KEY_PREFIX = "active-device-id:";
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
  private readonly pending = new Map<string, PendingRequest>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      return this.handleConnect(request, url);
    }

    if (url.pathname === "/execute") {
      return this.handleExecute(request);
    }

    if (url.pathname === "/status") {
      return this.handleStatus(request);
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
    this.ctx.acceptWebSocket(server, [deviceId]);
    server.serializeAttachment({ deviceId });

    for (const socket of this.ctx.getWebSockets(deviceId)) {
      if (socket === server) continue;
      socket.close(1000, "replaced");
    }

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
    await this.ctx.storage.put(this.activeDeviceKey(userId), deviceId);

    server.send(
      JSON.stringify({
        type: "connected",
        deviceId,
        organizationId,
        active: true,
      }),
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "godtool-device" },
    });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const deviceId = this.deviceIdForSocket(socket);
    if (!deviceId) return;
    await this.handleMessage(deviceId, socket, data);
  }

  async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const deviceId = this.deviceIdForSocket(socket);
    if (!deviceId) return;
    await this.markOffline(deviceId, socket);
  }

  async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    const deviceId = this.deviceIdForSocket(socket);
    if (!deviceId) return;
    await this.markOffline(deviceId, socket);
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

    const activeDeviceId = await this.resolveActiveSocketDeviceId(userId);
    if (!activeDeviceId) {
      return json({ error: "no_connected_device" }, { status: 409 });
    }

    const socket = this.activeSocketForDevice(activeDeviceId);
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

  private async handleStatus(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }

    const userId = request.headers.get(INTERNAL_USER_ID_HEADER);
    const organizationId = request.headers.get(INTERNAL_ORGANIZATION_ID_HEADER);
    const organizationName = request.headers.get(INTERNAL_ORGANIZATION_NAME_HEADER);
    if (!userId || !organizationId || !organizationName) {
      return json({ error: "unauthorized" }, { status: 401 });
    }

    const activeDeviceId = await this.resolveActiveSocketDeviceId(userId);
    const liveDeviceIds = new Set(
      this.ctx
        .getWebSockets()
        .map((socket) => this.deviceIdForSocket(socket))
        .filter((deviceId): deviceId is string => deviceId !== null),
    );
    const records = await this.ctx.storage.list<DeviceRecord>({ prefix: DEVICE_KEY_PREFIX });
    const devices = [...records.values()]
      .filter((device) => device.organizationId === organizationId && device.userId === userId)
      .map((device) => ({
        ...device,
        online: liveDeviceIds.has(device.deviceId),
      }))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);

    return json({ activeDeviceId, devices });
  }

  private async resolveActiveSocketDeviceId(userId: string): Promise<string | null> {
    const activeDeviceId = await this.ctx.storage.get<string>(this.activeDeviceKey(userId));
    if (activeDeviceId && this.activeSocketForDevice(activeDeviceId)) {
      const activeDevice = await this.ctx.storage.get<DeviceRecord>(this.deviceKey(activeDeviceId));
      if (activeDevice?.userId === userId) return activeDeviceId;
    }

    for (const socket of this.ctx.getWebSockets()) {
      const deviceId = this.deviceIdForSocket(socket);
      if (!deviceId) continue;
      const device = await this.ctx.storage.get<DeviceRecord>(this.deviceKey(deviceId));
      if (device?.userId === userId) return deviceId;
    }
    return null;
  }

  private activeSocketForDevice(deviceId: string): WebSocket | null {
    return (
      this.ctx.getWebSockets(deviceId).find((socket) => socket.readyState === WebSocket.OPEN) ??
      null
    );
  }

  private deviceIdForSocket(socket: WebSocket): string | null {
    const attachment = socket.deserializeAttachment() as
      | { readonly deviceId?: unknown }
      | undefined;
    return typeof attachment?.deviceId === "string" ? attachment.deviceId : null;
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

    const type = message.type;
    if (message.status === "completed" && "result" in message) {
      return {
        type,
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
        type,
        requestId: message.requestId,
        status: "error",
        error,
      };
    }

    return null;
  }

  private async markOffline(deviceId: string, socket: WebSocket): Promise<void> {
    const activeSocket = this.activeSocketForDevice(deviceId);
    if (activeSocket && activeSocket !== socket) return;

    const device = await this.ctx.storage.get<DeviceRecord>(this.deviceKey(deviceId));
    if (!device) return;
    const activeDeviceKey = this.activeDeviceKey(device.userId);
    const activeDeviceId = await this.ctx.storage.get<string>(activeDeviceKey);
    if (activeDeviceId === deviceId) {
      await this.ctx.storage.delete(activeDeviceKey);
    }

    this.rejectPendingForDevice(deviceId, new Error("device_disconnected"));
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

  private activeDeviceKey(userId: string): string {
    return `${ACTIVE_DEVICE_KEY_PREFIX}${userId}`;
  }

  private deviceKey(deviceId: string): string {
    return `${DEVICE_KEY_PREFIX}${deviceId}`;
  }
}
