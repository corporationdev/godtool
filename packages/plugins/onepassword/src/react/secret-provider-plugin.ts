import { lazy } from "react";
import type { SecretProviderPlugin } from "@executor/react/plugins/secret-provider-plugin";

export const onePasswordSecretProviderPlugin: SecretProviderPlugin = {
  key: "onepassword",
  label: "1Password",
  settings: lazy(() => import("./OnePasswordSettings")),
};
