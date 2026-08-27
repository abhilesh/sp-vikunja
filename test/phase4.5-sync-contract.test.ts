import { expect, it } from 'vitest';

import {
  buildLinkedTaskIdentity,
  classifyCreateReconciliation,
  classifyRemoteTaskState,
  classifyRetryDisposition,
  reconcileFieldState
} from '../src/vikunja/sync-contract.js';

it('builds identity from normalized base URL plus canonical positive integer task id', () => {
  expect(buildLinkedTaskIdentity(' https://vikunja.example/root/ ', '42')).toEqual({
    providerIdentity: 'https://vikunja.example/root',
    remoteTaskId: 42,
    linkKey: 'https://vikunja.example/root::42'
  });
});

it('treats a base-url change as a distinct provider identity without rebinding existing links', () => {
  expect(buildLinkedTaskIdentity('https://vikunja.example', 42).linkKey).not.toBe(
    buildLinkedTaskIdentity('https://vikunja.example/alt', 42).linkKey,
  );
});

it.each(['0', '-1', '0042', '4.2', 'abc', '+42'])(
  'rejects non-canonical task ids (%s)',
  (taskId) => {
    expect(() => buildLinkedTaskIdentity('https://vikunja.example', taskId)).toThrowError(
      /canonical positive integer/i,
    );
  },
);

it('rejects unsafe numeric task ids that cannot be represented canonically', () => {
  expect(() =>
    buildLinkedTaskIdentity('https://vikunja.example', Number.MAX_SAFE_INTEGER + 1),
  ).toThrowError(/canonical positive integer/i);
});

it('leaves a clean field untouched when neither side changed it', () => {
  expect(
    reconcileFieldState({
      field: 'title',
      localValue: 'Imported title',
      remoteValue: 'Imported title',
      lastSyncedValue: 'Imported title',
      dirty: false
    }),
  ).toEqual({
    field: 'title',
    outcome: 'noop',
    localValue: 'Imported title',
    dirty: false
  });
});

it('keeps a dirty field isolated while allowing non-dirty fields to refresh from remote', () => {
  expect(
    reconcileFieldState({
      field: 'title',
      localValue: 'Locally edited title',
      remoteValue: 'Imported title',
      lastSyncedValue: 'Imported title',
      dirty: true
    }),
  ).toEqual({
    field: 'title',
    outcome: 'preserve-local-dirty',
    localValue: 'Locally edited title',
    dirty: true
  });

  expect(
    reconcileFieldState({
      field: 'description',
      localValue: 'Imported body',
      remoteValue: 'Remotely edited body',
      lastSyncedValue: 'Imported body',
      dirty: false
    }),
  ).toEqual({
    field: 'description',
    outcome: 'refresh-local-from-remote',
    localValue: 'Remotely edited body',
    dirty: false
  });
});

it('retains the local dirty value and remote diagnostic value when a field conflicts', () => {
  expect(
    reconcileFieldState({
      field: 'dueDate',
      localValue: '2026-09-01',
      remoteValue: '2026-09-03',
      lastSyncedValue: '2026-08-31',
      dirty: true
    }),
  ).toEqual({
    field: 'dueDate',
    outcome: 'conflict',
    localValue: '2026-09-01',
    dirty: true,
    conflict: {
      remoteValue: '2026-09-03',
      lastSyncedValue: '2026-08-31',
      requiresUserResolution: true
    }
  });
});

it('classifies retry handling without creating timers or automatic retries', () => {
  expect(classifyRetryDisposition({ status: 401 })).toEqual({
    retryable: false,
    strategy: 'no-automatic-retry',
    reason: 'auth-or-validation'
  });

  expect(classifyRetryDisposition({ status: 429, retryAfter: '120' })).toEqual({
    retryable: true,
    strategy: 'respect-retry-after',
    reason: 'rate-limited',
    retryAfterSeconds: 120
  });

  expect(classifyRetryDisposition({ status: 429 })).toEqual({
    retryable: true,
    strategy: 'bounded-backoff-later',
    reason: 'rate-limited'
  });

  expect(classifyRetryDisposition({ status: 503 })).toEqual({
    retryable: true,
    strategy: 'bounded-backoff-later',
    reason: 'server-or-network'
  });

  expect(classifyRetryDisposition({ networkFailure: true })).toEqual({
    retryable: true,
    strategy: 'bounded-backoff-later',
    reason: 'server-or-network'
  });
});

it('accepts bounded Retry-After delay-seconds values and rejects malformed or unsafe ones', () => {
  expect(classifyRetryDisposition({ status: 429, retryAfter: '0' })).toEqual({
    retryable: true,
    strategy: 'respect-retry-after',
    reason: 'rate-limited',
    retryAfterSeconds: 0
  });

  expect(classifyRetryDisposition({ status: 429, retryAfter: '86400' })).toEqual({
    retryable: true,
    strategy: 'respect-retry-after',
    reason: 'rate-limited',
    retryAfterSeconds: 86400
  });

  expect(() => classifyRetryDisposition({ status: 429, retryAfter: 'abc' })).toThrowError(
    /retry-after delay-seconds/i,
  );

  expect(() => classifyRetryDisposition({ status: 429, retryAfter: ' 120 ' })).toThrowError(
    /retry-after delay-seconds/i,
  );

  expect(() => classifyRetryDisposition({ status: 429, retryAfter: '86401' })).toThrowError(
    /retry-after delay-seconds/i,
  );

  expect(() =>
    classifyRetryDisposition({ status: 429, retryAfter: String(Number.MAX_SAFE_INTEGER + 1) }),
  ).toThrowError(/retry-after delay-seconds/i);
});

it('marks a linked remote task unavailable on 404 without deleting local history', () => {
  expect(classifyRemoteTaskState({ status: 404, projectId: '7' })).toEqual({
    availability: 'unavailable',
    preserveLocalHistory: true,
    providerIdentityStable: true,
    projectId: '7'
  });
});

it('keeps identity stable when the task moves projects and only updates project metadata', () => {
  expect(classifyRemoteTaskState({ status: 200, projectId: '9' })).toEqual({
    availability: 'available',
    preserveLocalHistory: true,
    providerIdentityStable: true,
    projectId: '9'
  });
});

it('surfaces uncertain create reconciliation and refuses to auto-link duplicates', () => {
  expect(
    classifyCreateReconciliation({
      responseState: 'uncertain',
      matchingRemoteTaskIds: [18, 22]
    }),
  ).toEqual({
    outcome: 'manual-reconciliation-required',
    shouldAutoCreate: false,
    shouldAutoLink: false,
    requiresUniqueRemoteMatch: true,
    matchingRemoteTaskIds: [18, 22]
  });
});
