const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const readRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

export const renderSandboxToolCallErrorMessage = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  const record = readRecord(value);
  if (!record) {
    return String(value);
  }

  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message;
  }

  if (record._tag === "ToolNotFoundError" && typeof record.toolId === "string") {
    return `Tool not found: ${record.toolId}`;
  }

  if (record._tag === "PluginNotLoadedError" && typeof record.toolId === "string") {
    return `Tool "${record.toolId}" is registered but its plugin is not loaded`;
  }

  if (record._tag === "NoHandlerError" && typeof record.toolId === "string") {
    return `Tool "${record.toolId}" has no invocation handler`;
  }

  return safeJsonStringify(value);
};

export const formatSandboxToolCallErrorValue = (
  value: unknown,
): { readonly message: string; readonly details?: unknown } => {
  const message = renderSandboxToolCallErrorMessage(value);
  const record = readRecord(value);

  if (!record) {
    return { message };
  }

  return {
    message,
    details: record,
  };
};
