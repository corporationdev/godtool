import { CloudApiClient } from "./client";

export const createFilesSession = CloudApiClient.mutation("files", "createSession");
export const ensurePersistentSandbox = CloudApiClient.mutation("files", "ensureSandbox");
