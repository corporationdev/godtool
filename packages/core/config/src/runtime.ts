import { getStageKind, type StageKind } from "./stage-kind";

const defaultBlaxelRegion = "us-pdx-1";
const defaultBlaxelTemplateImage = "sandbox/godtool:latest";
const defaultBlaxelWorkspace = "godtool";
const previewSubdomainPrefix = "preview-pr-";
const productionSubdomain = "app";
const rootDomain = "godtool.dev";
const serverSubdomainPrefix = "server-";
const localCloudUrl = "http://localhost:3001";
const productionAuthkitDomain = "https://reverent-value-48.authkit.app";
const stagingAuthkitDomain = "https://balanced-mirage-25-staging.authkit.app";
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
  blaxelRegion: string;
  blaxelTemplateImage: string;
  blaxelWorkspace: string;
  cloudWorkerName: string;
  serverHostname: string;
  serverUrl: string;
  stage: string;
  stageKind: Exclude<StageKind, "test" | "unknown">;
}

function assertSupportedRuntimeStage(stage: string): Exclude<StageKind, "test" | "unknown"> {
  const stageKind = getStageKind(stage);

  if (stageKind !== "dev" && stageKind !== "preview" && stageKind !== "production") {
    throw new Error(`Unsupported stage "${stage}" for runtime resolution.`);
  }

  return stageKind;
}

export function getStageAppHostname(stage: string): string | null {
  const stageKind = getStageKind(stage);

  if (stageKind === "dev") {
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

export function getStageServerHostname(stage: string): string {
  const stageKind = getStageKind(stage);

  if (stageKind === "dev") {
    return `${getSingleLabelSubdomain(serverSubdomainPrefix, stage)}.${rootDomain}`;
  }

  const appHostname = getStageAppHostname(stage);
  if (appHostname) {
    return appHostname;
  }

  throw new Error(`Unsupported stage "${stage}" for server hostname resolution.`);
}

export function getStageServerUrl(stage: string): string {
  return `https://${getStageServerHostname(stage)}`;
}

export function getStageAuthkitDomain(stage: string): string {
  const stageKind = assertSupportedRuntimeStage(stage);

  if (stageKind === "production") {
    return productionAuthkitDomain;
  }

  return stagingAuthkitDomain;
}

export function getStageBlaxelWorkspace(stage: string): string {
  assertSupportedRuntimeStage(stage);
  return defaultBlaxelWorkspace;
}

export function getStageBlaxelRegion(stage: string): string {
  assertSupportedRuntimeStage(stage);
  return defaultBlaxelRegion;
}

export function getStageBlaxelTemplateImage(stage: string): string {
  assertSupportedRuntimeStage(stage);
  return defaultBlaxelTemplateImage;
}

export function getStageCloudWorkerName(stage: string): string {
  const stageKind = getStageKind(stage);

  if (stageKind === "dev") {
    return `godtool-web-${stage}`;
  }
  if (stageKind === "preview" || stageKind === "test") {
    const previewLabel = stage.replace(previewStagePrefixRegex, "");
    return `godtool-web-preview-${previewLabel}`;
  }
  if (stageKind === "production") {
    return "godtool-web-production";
  }

  throw new Error(`Unsupported stage "${stage}" for cloud worker resolution.`);
}

export function resolveRuntimeContext(stage: string): RuntimeContext {
  const stageKind = assertSupportedRuntimeStage(stage);

  return {
    appHostname: getStageAppHostname(stage),
    appUrl: getStageAppUrl(stage),
    authkitDomain: getStageAuthkitDomain(stage),
    blaxelRegion: getStageBlaxelRegion(stage),
    blaxelTemplateImage: getStageBlaxelTemplateImage(stage),
    blaxelWorkspace: getStageBlaxelWorkspace(stage),
    cloudWorkerName: getStageCloudWorkerName(stage),
    serverHostname: getStageServerHostname(stage),
    serverUrl: getStageServerUrl(stage),
    stage,
    stageKind,
  };
}
