import type { PluginSecretAPI } from '../vikunja/types.js';

export const VIKUNJA_SECRET_KEYS = {
  apiToken: 'vikunja.apiToken'
} as const;

export type VikunjaSecretKey =
  (typeof VIKUNJA_SECRET_KEYS)[keyof typeof VIKUNJA_SECRET_KEYS];

export type VikunjaSecretStore = Pick<
  PluginSecretAPI,
  'getSecret' | 'setSecret' | 'deleteSecret'
>;

export async function getVikunjaApiToken(
  secretStore: VikunjaSecretStore,
): Promise<string | null> {
  return secretStore.getSecret(VIKUNJA_SECRET_KEYS.apiToken);
}

export async function setVikunjaApiToken(
  secretStore: VikunjaSecretStore,
  token: string,
): Promise<void> {
  await secretStore.setSecret(VIKUNJA_SECRET_KEYS.apiToken, token);
}

export async function deleteVikunjaApiToken(
  secretStore: VikunjaSecretStore,
): Promise<void> {
  await secretStore.deleteSecret(VIKUNJA_SECRET_KEYS.apiToken);
}
