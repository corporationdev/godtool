import { CloudApiClient } from "./client";

export const createFilesSession = CloudApiClient.mutation("files", "createSession");
