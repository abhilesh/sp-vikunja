import { normalizeBaseUrl } from './client.js';

export interface LinkedTaskIdentity {
  providerIdentity: string;
  remoteTaskId: number;
  linkKey: string;
}

export interface ReconcileFieldStateInput<TValue> {
  field: string;
  localValue: TValue;
  remoteValue: TValue;
  lastSyncedValue: TValue;
  dirty: boolean;
}

export type FieldConflict<TValue> = {
  remoteValue: TValue;
  lastSyncedValue: TValue;
  requiresUserResolution: true;
};

export type ReconcileFieldStateResult<TValue> =
  | {
      field: string;
      outcome: 'noop' | 'preserve-local-dirty';
      localValue: TValue;
      dirty: boolean;
    }
  | {
      field: string;
      outcome: 'refresh-local-from-remote';
      localValue: TValue;
      dirty: false;
    }
  | {
      field: string;
      outcome: 'conflict';
      localValue: TValue;
      dirty: true;
      conflict: FieldConflict<TValue>;
    };

export interface RetryDispositionInput {
  status?: number;
  retryAfter?: string | null;
  networkFailure?: boolean;
}

export type RetryDisposition =
  | {
      retryable: false;
      strategy: 'no-automatic-retry';
      reason: 'auth-or-validation' | 'non-retryable';
    }
  | {
      retryable: true;
      strategy: 'respect-retry-after';
      reason: 'rate-limited';
      retryAfterSeconds: number;
    }
  | {
      retryable: true;
      strategy: 'bounded-backoff-later';
      reason: 'rate-limited' | 'server-or-network';
    };

export interface RemoteTaskStateInput {
  status: number;
  projectId?: string;
}

export interface RemoteTaskState {
  availability: 'available' | 'unavailable';
  preserveLocalHistory: true;
  providerIdentityStable: true;
  projectId?: string;
}

export interface CreateReconciliationInput {
  responseState: 'confirmed' | 'uncertain';
  matchingRemoteTaskIds: number[];
}

const MAX_RETRY_AFTER_SECONDS = 86_400;

export type CreateReconciliationResult =
  | {
      outcome: 'linked';
      shouldAutoCreate: false;
      shouldAutoLink: true;
      requiresUniqueRemoteMatch: false;
      matchingRemoteTaskIds: number[];
    }
  | {
      outcome: 'manual-reconciliation-required';
      shouldAutoCreate: false;
      shouldAutoLink: false;
      requiresUniqueRemoteMatch: true;
      matchingRemoteTaskIds: number[];
    };

function parseCanonicalPositiveInteger(taskId: number | string): number {
  if (typeof taskId === 'number') {
    if (Number.isSafeInteger(taskId) && taskId > 0) {
      return taskId;
    }

    throw new Error('Remote task IDs must be a canonical positive integer.');
  }

  if (!/^[1-9]\d*$/.test(taskId)) {
    throw new Error('Remote task IDs must be a canonical positive integer.');
  }

  const parsedTaskId = Number(taskId);

  if (!Number.isSafeInteger(parsedTaskId) || parsedTaskId <= 0) {
    throw new Error('Remote task IDs must be a canonical positive integer.');
  }

  return parsedTaskId;
}

function parseRetryAfterSeconds(retryAfter: string | null | undefined): number | undefined {
  if (retryAfter === undefined || retryAfter === null) {
    return undefined;
  }

  if (!retryAfter) {
    throw new Error(`Retry-After delay-seconds must be a canonical integer between 0 and ${MAX_RETRY_AFTER_SECONDS}.`);
  }

  if (!/^(0|[1-9]\d*)$/.test(retryAfter)) {
    throw new Error(`Retry-After delay-seconds must be a canonical integer between 0 and ${MAX_RETRY_AFTER_SECONDS}.`);
  }

  const parsedRetryAfter = Number(retryAfter);

  if (!Number.isSafeInteger(parsedRetryAfter) || parsedRetryAfter < 0 || parsedRetryAfter > MAX_RETRY_AFTER_SECONDS) {
    throw new Error(`Retry-After delay-seconds must be between 0 and ${MAX_RETRY_AFTER_SECONDS}.`);
  }

  return parsedRetryAfter;
}

export function buildLinkedTaskIdentity(baseUrl: string, taskId: number | string): LinkedTaskIdentity {
  const providerIdentity = normalizeBaseUrl(baseUrl);
  const remoteTaskId = parseCanonicalPositiveInteger(taskId);

  return {
    providerIdentity,
    remoteTaskId,
    linkKey: `${providerIdentity}::${remoteTaskId}`
  };
}

export function reconcileFieldState<TValue>(
  input: ReconcileFieldStateInput<TValue>,
): ReconcileFieldStateResult<TValue> {
  const { field, localValue, remoteValue, lastSyncedValue, dirty } = input;
  const remoteChanged = remoteValue !== lastSyncedValue;

  if (!dirty) {
    if (!remoteChanged) {
      return {
        field,
        outcome: 'noop',
        localValue,
        dirty: false
      };
    }

    return {
      field,
      outcome: 'refresh-local-from-remote',
      localValue: remoteValue,
      dirty: false
    };
  }

  if (!remoteChanged) {
    return {
      field,
      outcome: 'preserve-local-dirty',
      localValue,
      dirty: true
    };
  }

  return {
    field,
    outcome: 'conflict',
    localValue,
    dirty: true,
    conflict: {
      remoteValue,
      lastSyncedValue,
      requiresUserResolution: true
    }
  };
}

export function classifyRetryDisposition(input: RetryDispositionInput): RetryDisposition {
  const { status, retryAfter, networkFailure } = input;

  if (status === 401 || status === 403 || status === 404 || status === 422) {
    return {
      retryable: false,
      strategy: 'no-automatic-retry',
      reason: 'auth-or-validation'
    };
  }

  if (status === 429) {
    if (retryAfter !== undefined && retryAfter !== null) {
      const retryAfterSeconds = parseRetryAfterSeconds(retryAfter);

      if (retryAfterSeconds === undefined) {
        throw new Error(
          `Retry-After delay-seconds must be a canonical integer between 0 and ${MAX_RETRY_AFTER_SECONDS}.`,
        );
      }

      return {
        retryable: true,
        strategy: 'respect-retry-after',
        reason: 'rate-limited',
        retryAfterSeconds
      };
    }

    return {
      retryable: true,
      strategy: 'bounded-backoff-later',
      reason: 'rate-limited'
    };
  }

  if (networkFailure || (status !== undefined && status >= 500 && status <= 599)) {
    return {
      retryable: true,
      strategy: 'bounded-backoff-later',
      reason: 'server-or-network'
    };
  }

  return {
    retryable: false,
    strategy: 'no-automatic-retry',
    reason: 'non-retryable'
  };
}

export function classifyRemoteTaskState(input: RemoteTaskStateInput): RemoteTaskState {
  if (input.status === 404) {
    return {
      availability: 'unavailable',
      preserveLocalHistory: true,
      providerIdentityStable: true,
      projectId: input.projectId
    };
  }

  return {
    availability: 'available',
    preserveLocalHistory: true,
    providerIdentityStable: true,
    projectId: input.projectId
  };
}

export function classifyCreateReconciliation(
  input: CreateReconciliationInput,
): CreateReconciliationResult {
  const { responseState, matchingRemoteTaskIds } = input;

  if (responseState === 'confirmed' && matchingRemoteTaskIds.length === 1) {
    return {
      outcome: 'linked',
      shouldAutoCreate: false,
      shouldAutoLink: true,
      requiresUniqueRemoteMatch: false,
      matchingRemoteTaskIds
    };
  }

  return {
    outcome: 'manual-reconciliation-required',
    shouldAutoCreate: false,
    shouldAutoLink: false,
    requiresUniqueRemoteMatch: true,
    matchingRemoteTaskIds
  };
}
