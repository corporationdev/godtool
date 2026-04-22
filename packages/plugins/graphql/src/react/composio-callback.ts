const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export const graphqlComposioCallbackUrl = (path: string): string => {
  if (typeof window !== "undefined") {
    return `${window.location.origin}${path}`;
  }

  const publicSiteUrl =
    typeof import.meta !== "undefined"
      ? (
          import.meta as ImportMeta & {
            readonly env?: { readonly VITE_PUBLIC_SITE_URL?: string };
          }
        ).env?.VITE_PUBLIC_SITE_URL?.trim()
      : undefined;

  if (publicSiteUrl) {
    return `${trimTrailingSlash(publicSiteUrl)}${path}`;
  }

  return path;
};
