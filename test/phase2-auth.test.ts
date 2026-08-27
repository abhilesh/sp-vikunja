import { expect, it, vi } from 'vitest';

import {
  VIKUNJA_SECRET_KEYS,
  deleteVikunjaApiToken,
  getVikunjaApiToken,
  setVikunjaApiToken
} from '../src/config/secrets.js';
import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { normalizeBaseUrl } from '../src/vikunja/client.js';

it('normalizes a Vikunja base URL by trimming whitespace and trailing slashes', () => {
  expect(normalizeBaseUrl('  https://vikunja.example/app/  ')).toBe('https://vikunja.example/app');
});

it('preserves the configured base path while normalizing URL punctuation', () => {
  expect(normalizeBaseUrl('https://vikunja.example/root/path///')).toBe(
    'https://vikunja.example/root/path',
  );
});

it.each(['', '   ', 'not-a-url'])('rejects invalid Vikunja base URLs: %s', (baseUrl) => {
  expect(() => normalizeBaseUrl(baseUrl)).toThrowError(/Vikunja base URL/i);
});

it('reads the Vikunja token from secret storage and formats the Authorization header', async () => {
  const secretApi = {
    getSecret: vi.fn(async (key: string) => {
      expect(key).toBe(VIKUNJA_SECRET_KEYS.apiToken);
      return 'synthetic-token';
    })
  };

  const definition = buildVikunjaIssueProviderDefinition(secretApi as never);

  await expect(definition.getHeaders({ baseUrl: 'https://vikunja.example/' })).resolves.toEqual({
    Authorization: 'Bearer synthetic-token'
  });
  expect(secretApi.getSecret).toHaveBeenCalledTimes(1);
});

it('fails connection checks before calling HTTP when the token is missing', async () => {
  const secretApi = {
    getSecret: vi.fn(async () => null)
  };
  const http = {
    get: vi.fn()
  };

  const definition = buildVikunjaIssueProviderDefinition(secretApi as never);

  await expect(
    definition.testConnection?.({ baseUrl: 'https://vikunja.example/' }, http as never),
  ).rejects.toThrowError(/API token/i);
  expect(http.get).not.toHaveBeenCalled();
});

it('tests the verified project-list endpoint with page and per_page parameters', async () => {
  const secretApi = {
    getSecret: vi.fn(async () => 'synthetic-token')
  };
  const http = {
    get: vi.fn(async () => ({
      items: [],
      page: 1,
      per_page: 1,
      total: 0,
      total_pages: 0
    }))
  };

  const definition = buildVikunjaIssueProviderDefinition(secretApi as never);

  await expect(
    definition.testConnection?.({ baseUrl: 'https://vikunja.example/' }, http as never),
  ).resolves.toBe(true);
  expect(http.get).toHaveBeenCalledWith(
    'https://vikunja.example/api/v2/projects',
    expect.objectContaining({
      params: {
        page: '1',
        per_page: '1'
      },
      headers: {
        Authorization: 'Bearer synthetic-token'
      }
    }),
  );
});

it.each([
  [401, 'authentication'],
  [403, 'authentication'],
  ['network', 'unable to reach']
] as const)('normalizes %s failures without leaking tokens', async (failure, expectedMessage) => {
  const secretApi = {
    getSecret: vi.fn(async () => 'synthetic-token')
  };
  const http = {
    get: vi.fn(async () => {
      if (failure === 'network') {
        throw new Error('fetch failed');
      }

      const error = new Error(`request failed with ${failure}`);
      Object.assign(error, { status: failure });
      throw error;
    })
  };

  const definition = buildVikunjaIssueProviderDefinition(secretApi as never);

  try {
    await definition.testConnection?.({ baseUrl: 'https://vikunja.example/' }, http as never);
    throw new Error('expected the connection test to fail');
  } catch (error) {
    expect(String(error)).toMatch(new RegExp(expectedMessage, 'i'));
    expect(String(error)).not.toContain('synthetic-token');
  }
});

it('wraps the secret storage API with the fixed Vikunja token key', async () => {
  const secretApi = {
    getSecret: vi.fn(async () => 'stored-token'),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined)
  };

  await expect(getVikunjaApiToken(secretApi as never)).resolves.toBe('stored-token');
  await expect(setVikunjaApiToken(secretApi as never, 'new-token')).resolves.toBeUndefined();
  await expect(deleteVikunjaApiToken(secretApi as never)).resolves.toBeUndefined();

  expect(secretApi.getSecret).toHaveBeenCalledWith(VIKUNJA_SECRET_KEYS.apiToken);
  expect(secretApi.setSecret).toHaveBeenCalledWith(VIKUNJA_SECRET_KEYS.apiToken, 'new-token');
  expect(secretApi.deleteSecret).toHaveBeenCalledWith(VIKUNJA_SECRET_KEYS.apiToken);
});
