import { Effect } from "effect";
import {
  ConnectionId,
  CreateConnectionInput,
  ScopeId,
  SecretId,
  SetSecretInput,
  TokenMaterial,
} from "@executor/sdk";

type SyncExecutor = any;

type SyncSource = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly pluginId: string;
  readonly url?: string;
  readonly runtime: boolean;
  readonly canRemove: boolean;
};

type OpenApiBinding = {
  readonly slot: string;
  readonly value: unknown;
};

export type PortableSecret = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
};

export type PortableConnection = {
  readonly id: string;
  readonly provider: string;
  readonly identityLabel: string | null;
  readonly accessToken: string;
  readonly accessTokenSecretId: string;
  readonly refreshToken: string | null;
  readonly refreshTokenSecretId: string | null;
  readonly expiresAt: number | null;
  readonly oauthScope: string | null;
  readonly providerState: Record<string, unknown> | null;
};

export type PortableSourcePackage = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly pluginId: string;
  readonly config: unknown;
  readonly bindings?: readonly OpenApiBinding[];
  readonly secrets: readonly PortableSecret[];
  readonly connections: readonly PortableConnection[];
};

export type SourceImportCandidate = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly pluginId: string;
};

const CLOUD_CAPABLE_KINDS = new Set(["openapi", "graphql", "raw", "googleDiscovery", "mcp"]);

export const isCloudCapableSourceKind = (kind: string) => CLOUD_CAPABLE_KINDS.has(kind);

const run = <T = any>(effect: unknown): Promise<T> =>
  Effect.runPromise(effect as Effect.Effect<T, unknown, never>);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const collectRefs = (value: unknown, secretIds: Set<string>, connectionIds: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, secretIds, connectionIds);
    return;
  }

  if (typeof value !== "object" || value === null) return;
  const object = value as Record<string, unknown>;
  if (typeof object.secretId === "string") secretIds.add(object.secretId);
  if (typeof object.clientIdSecretId === "string") secretIds.add(object.clientIdSecretId);
  if (typeof object.clientSecretSecretId === "string") secretIds.add(object.clientSecretSecretId);
  if (typeof object.connectionId === "string") connectionIds.add(object.connectionId);
  for (const child of Object.values(object)) collectRefs(child, secretIds, connectionIds);
};

const getSourceConfig = async (
  executor: SyncExecutor,
  source: SyncSource,
  scopeId: string,
): Promise<{ readonly config: unknown; readonly bindings?: readonly OpenApiBinding[] } | null> => {
  if (source.kind === "openapi" && executor.openapi) {
    const config = await run(executor.openapi.getSource(source.id, scopeId));
    if (!config) return null;
    const bindings = executor.openapi.listSourceBindings
      ? await run(executor.openapi.listSourceBindings(source.id, scopeId))
      : [];
    return { config, bindings };
  }
  if (source.kind === "graphql" && executor.graphql) {
    const config = await run(executor.graphql.getSource(source.id, scopeId));
    return config ? { config } : null;
  }
  if (source.kind === "raw" && executor.raw) {
    const config = await run(executor.raw.getSource(source.id, scopeId));
    return config ? { config } : null;
  }
  if (source.kind === "googleDiscovery" && executor.googleDiscovery) {
    const config = await run(executor.googleDiscovery.getSource(source.id, scopeId));
    return config ? { config } : null;
  }
  if (source.kind === "mcp" && executor.mcp) {
    const config = await run(executor.mcp.getSource(source.id, scopeId));
    return config ? { config } : null;
  }
  return null;
};

const canSyncConfig = (source: SyncSource, config: unknown): boolean => {
  if (!isCloudCapableSourceKind(source.kind)) return false;
  if (source.runtime || !source.canRemove) return false;
  if (source.kind !== "mcp") return true;
  return asRecord(asRecord(config).config).transport !== "stdio";
};

const exportSecrets = async (
  executor: SyncExecutor,
  secretIds: Iterable<string>,
): Promise<readonly PortableSecret[]> => {
  const out: PortableSecret[] = [];
  for (const id of new Set(secretIds)) {
    const value = await run(executor.secrets.get(id)).catch(() => null);
    if (value == null) continue;
    out.push({ id, name: id, value });
  }
  return out;
};

const exportConnections = async (
  executor: SyncExecutor,
  connectionIds: Iterable<string>,
): Promise<readonly PortableConnection[]> => {
  const out: PortableConnection[] = [];
  for (const id of new Set(connectionIds)) {
    const connection = await run(executor.connections.get(id)).catch(() => null);
    if (!connection) continue;
    const accessToken = await run(executor.connections.accessToken(id)).catch(() => null);
    if (!accessToken) continue;
    const refreshTokenSecretId =
      typeof connection.refreshTokenSecretId === "string" ? connection.refreshTokenSecretId : null;
    const refreshToken = refreshTokenSecretId
      ? await run<string | null>(executor.secrets.get(refreshTokenSecretId)).catch(() => null)
      : null;
    out.push({
      id,
      provider: connection.provider,
      identityLabel: connection.identityLabel,
      accessToken,
      accessTokenSecretId: connection.accessTokenSecretId,
      refreshToken,
      refreshTokenSecretId,
      expiresAt: connection.expiresAt,
      oauthScope: connection.oauthScope,
      providerState: connection.providerState,
    });
  }
  return out;
};

export const listSourceImportCandidates = async (
  executor: SyncExecutor,
  scopeId: string,
): Promise<readonly SourceImportCandidate[]> => {
  const sources = await run<readonly SyncSource[]>(executor.sources.list());
  const out: SourceImportCandidate[] = [];
  for (const source of sources) {
    if (!isCloudCapableSourceKind(source.kind) || source.runtime || !source.canRemove) continue;
    const loaded = await getSourceConfig(executor, source, scopeId).catch(() => null);
    if (!loaded || !canSyncConfig(source, loaded.config)) continue;
    out.push({
      id: source.id,
      kind: source.kind,
      name: source.name,
      pluginId: source.pluginId,
    });
  }
  return out;
};

export const exportSourcePackages = async (
  executor: SyncExecutor,
  sourceIds: readonly string[],
  scopeId: string,
): Promise<readonly PortableSourcePackage[]> => {
  const sources = await run<readonly SyncSource[]>(executor.sources.list());
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const packages: PortableSourcePackage[] = [];
  for (const sourceId of sourceIds) {
    const source = sourceById.get(sourceId);
    if (!source) continue;
    const loaded = await getSourceConfig(executor, source, scopeId);
    if (!loaded || !canSyncConfig(source, loaded.config)) continue;
    const secretIds = new Set<string>();
    const connectionIds = new Set<string>();
    collectRefs(loaded.config, secretIds, connectionIds);
    collectRefs(loaded.bindings, secretIds, connectionIds);
    packages.push({
      id: source.id,
      kind: source.kind,
      name: source.name,
      pluginId: source.pluginId,
      config: loaded.config,
      ...(loaded.bindings ? { bindings: loaded.bindings } : {}),
      secrets: await exportSecrets(executor, secretIds),
      connections: await exportConnections(executor, connectionIds),
    });
  }
  return packages;
};

const importSecrets = async (
  executor: SyncExecutor,
  sourcePackage: PortableSourcePackage,
  scopeId: string,
): Promise<void> => {
  for (const secret of sourcePackage.secrets) {
    await run(
      executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make(secret.id),
          scope: ScopeId.make(scopeId),
          name: secret.name,
          value: secret.value,
        }),
      ),
    );
  }
};

const importConnections = async (
  executor: SyncExecutor,
  sourcePackage: PortableSourcePackage,
  scopeId: string,
): Promise<void> => {
  for (const connection of sourcePackage.connections) {
    await run(
      executor.connections.create(
        new CreateConnectionInput({
          id: ConnectionId.make(connection.id),
          scope: ScopeId.make(scopeId),
          provider: connection.provider,
          identityLabel: connection.identityLabel,
          accessToken: new TokenMaterial({
            secretId: SecretId.make(connection.accessTokenSecretId),
            name: `Connection ${connection.id} access token`,
            value: connection.accessToken,
          }),
          refreshToken:
            connection.refreshToken && connection.refreshTokenSecretId
              ? new TokenMaterial({
                  secretId: SecretId.make(connection.refreshTokenSecretId),
                  name: `Connection ${connection.id} refresh token`,
                  value: connection.refreshToken,
                })
              : null,
          expiresAt: connection.expiresAt,
          oauthScope: connection.oauthScope,
          providerState: connection.providerState,
        }),
      ),
    ).catch(() => undefined);
  }
};

export const importSourcePackages = async (
  executor: SyncExecutor,
  packages: readonly PortableSourcePackage[],
  scopeId: string,
): Promise<readonly string[]> => {
  const imported: string[] = [];
  for (const sourcePackage of packages) {
    await importSecrets(executor, sourcePackage, scopeId);
    await importConnections(executor, sourcePackage, scopeId);
    const stored = asRecord(sourcePackage.config);
    const config = asRecord(stored.config);
    if (sourcePackage.kind === "openapi" && executor.openapi) {
      await run(
        executor.openapi.addSpec({
          scope: scopeId,
          spec: String(config.sourceUrl ?? config.spec ?? ""),
          name: stored.name ?? sourcePackage.name,
          namespace: sourcePackage.id,
          ...(typeof config.baseUrl === "string" ? { baseUrl: config.baseUrl } : {}),
          ...(config.headers ? { headers: config.headers } : {}),
          ...(config.oauth2 ? { oauth2: config.oauth2 } : {}),
          ...(config.managedAuth ? { managedAuth: config.managedAuth } : {}),
        }),
      );
      if (executor.openapi.setSourceBinding) {
        for (const binding of sourcePackage.bindings ?? []) {
          await run(
            executor.openapi.setSourceBinding({
              sourceId: sourcePackage.id,
              sourceScope: scopeId,
              targetScope: scopeId,
              slot: binding.slot,
              value: binding.value,
            }),
          ).catch(() => undefined);
        }
      }
    } else if (sourcePackage.kind === "graphql" && executor.graphql) {
      await run(
        executor.graphql.addSource({
          scope: scopeId,
          endpoint: stored.endpoint,
          name: stored.name ?? sourcePackage.name,
          namespace: sourcePackage.id,
          ...(stored.headers ? { headers: stored.headers } : {}),
          ...(stored.managedAuth ? { managedAuth: stored.managedAuth } : {}),
        }),
      );
    } else if (sourcePackage.kind === "raw" && executor.raw) {
      await run(
        executor.raw.addSource({
          scope: scopeId,
          baseUrl: stored.baseUrl,
          name: stored.name ?? sourcePackage.name,
          namespace: sourcePackage.id,
          ...(stored.headers ? { headers: stored.headers } : {}),
          ...(stored.composio ? { composio: stored.composio } : {}),
          ...(stored.auth ? { auth: stored.auth } : {}),
        }),
      );
    } else if (sourcePackage.kind === "googleDiscovery" && executor.googleDiscovery) {
      const googleConfig = asRecord(stored.config);
      await run(
        executor.googleDiscovery.addSource({
          scope: scopeId,
          discoveryUrl: googleConfig.discoveryUrl ?? stored.discoveryUrl,
          name: stored.name ?? sourcePackage.name,
          namespace: sourcePackage.id,
          auth: googleConfig.auth ?? stored.auth ?? { kind: "none" },
          ...(googleConfig.managedAuth ? { managedAuth: googleConfig.managedAuth } : {}),
        }),
      );
    } else if (sourcePackage.kind === "mcp" && executor.mcp) {
      if (config.transport === "stdio") continue;
      await run(
        executor.mcp.addSource({
          ...config,
          scope: scopeId,
          name: stored.name ?? sourcePackage.name,
          namespace: sourcePackage.id,
        }),
      );
    } else {
      continue;
    }
    imported.push(sourcePackage.id);
  }
  return imported;
};

export const deleteSourcePackages = async (
  executor: SyncExecutor,
  sourceIds: readonly string[],
): Promise<readonly string[]> => {
  const deleted: string[] = [];
  for (const sourceId of sourceIds) {
    await run(executor.sources.remove(sourceId));
    deleted.push(sourceId);
  }
  return deleted;
};
