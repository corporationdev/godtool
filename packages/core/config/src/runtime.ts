import { getStageKind, type StageKind } from "./stage-kind";

const previewSubdomainPrefix = "preview-pr-";
const productionSubdomain = "app";
const rootDomain = "godtool.dev";
const localCloudUrl = "http://executor-cloud.localhost:1355";
const sharedAuthkitDomain = "https://reverent-value-48.authkit.app";
const maxDnsLabelLength = 63;
const previewStagePrefixRegex = /^(preview-|pr-)/;

function shortHash(input: string): string {
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) % 4_294_967_296;
  }

  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

function getSingleLabelSubdomain(prefix: string, value: string): string {
  const baseLabel = `${prefix}${value}`;

  if (baseLabel.length <= maxDnsLabelLength) {
    return baseLabel;
  }

  const hashSuffix = `-${shortHash(value)}`;
  const maxValueLength = maxDnsLabelLength - prefix.length - hashSuffix.length;

  return `${prefix}${value.slice(0, maxValueLength)}${hashSuffix}`;
}

export interface RuntimeContext {
  appHostname: string | null;
  appUrl: string;
  authkitDomain: string;
  stage: string;
  stageKind: Exclude<StageKind, "test" | "unknown">;
}

export function getStageAppHostname(stage: string): string | null {
  const stageKind = getStageKind(stage);

  if (stageKind === "dev" || stageKind === "sandbox") {
    return null;
  }
  if (stageKind === "preview" || stageKind === "test") {
    const previewLabel = stage.replace(previewStagePrefixRegex, "");
    return `${getSingleLabelSubdomain(previewSubdomainPrefix, previewLabel)}.${rootDomain}`;
  }
  if (stageKind === "production") {
    return `${productionSubdomain}.${rootDomain}`;
  }

  throw new Error(`Unsupported stage "${stage}" for app hostname resolution.`);
}

export function getStageAppUrl(stage: string): string {
  const hostname = getStageAppHostname(stage);
  if (!hostname) {
    return localCloudUrl;
  }
  return `https://${hostname}`;
}

export function getStageAuthkitDomain(stage: string): string {
  const stageKind = getStageKind(stage);

  if (
    stageKind !== "dev" &&
    stageKind !== "sandbox" &&
    stageKind !== "preview" &&
    stageKind !== "production"
  ) {
    throw new Error(`Unsupported stage "${stage}" for authkit domain resolution.`);
  }

  return sharedAuthkitDomain;
}

export function resolveRuntimeContext(stage: string): RuntimeContext {
  const stageKind = getStageKind(stage);

  if (
    stageKind !== "dev" &&
    stageKind !== "sandbox" &&
    stageKind !== "preview" &&
    stageKind !== "production"
  ) {
    throw new Error(`Unsupported stage "${stage}" for runtime resolution.`);
  }

  return {
    appHostname: getStageAppHostname(stage),
    appUrl: getStageAppUrl(stage),
    authkitDomain: getStageAuthkitDomain(stage),
    stage,
    stageKind,
  };
}
