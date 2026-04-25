import { CloudApiClient } from "./client";

export const createDesktopSession = CloudApiClient.mutation("desktop", "createSession");
