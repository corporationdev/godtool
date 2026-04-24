import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";

import { addGroup } from "@executor/api";
import { getBaseUrl } from "@executor/react/api/base-url";

import { RawGroup } from "../api/group";

const RawApi = addGroup(RawGroup);

export const RawClient = AtomHttpApi.Tag<"RawClient">()("RawClient", {
  api: RawApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});
