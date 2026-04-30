import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";
import { addGroup } from "@executor/api";
import { getBaseUrl } from "@executor/react/api/base-url";
import { ComputerUseGroup } from "../api/group";

const ComputerUseApi = addGroup(ComputerUseGroup);

export const ComputerUseClient = AtomHttpApi.Tag<"ComputerUseClient">()(
  "ComputerUseClient",
  {
    api: ComputerUseApi,
    httpClient: FetchHttpClient.layer,
    baseUrl: getBaseUrl(),
  },
);
