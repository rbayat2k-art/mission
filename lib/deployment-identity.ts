import { APP_VERSION } from "./app-version";

const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/;
const FULL_GIT_SHA = /^[a-f0-9]{40}$/i;
const DEPLOYMENT_ENVIRONMENTS = new Set(["development", "test", "staging", "production"]);

export type DeploymentIdentity = {
  version: string;
  commit: string;
  environment: string;
};

/** Returns only validated, non-secret deployment metadata for the public health response. */
export function getDeploymentIdentity(env: Record<string, string | undefined> = process.env): DeploymentIdentity {
  const configuredVersion = env.APP_VERSION?.trim() ?? "";
  const configuredSha = env.APP_COMMIT_SHA?.trim() ?? "";
  const configuredEnvironment = env.APP_ENVIRONMENT?.trim().toLowerCase() ?? "";

  return {
    version: SAFE_VERSION.test(configuredVersion) ? configuredVersion : APP_VERSION,
    commit: FULL_GIT_SHA.test(configuredSha) ? configuredSha.toLowerCase() : "unknown",
    environment: DEPLOYMENT_ENVIRONMENTS.has(configuredEnvironment) ? configuredEnvironment : "unknown",
  };
}
