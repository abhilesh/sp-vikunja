export interface VikunjaLogEvent {
  event: 'request' | 'request-failure';
  operation: string;
  status?: number;
}

export type VikunjaLogSink = (event: VikunjaLogEvent) => void;

const REDACTED_KEYS = new Set(['authorization', 'token', 'apitoken', 'password', 'secret', 'credential']);
const OMITTED_KEYS = new Set(['title', 'description', 'body', 'notes', 'content']);

export function redactVikunjaLogValue(value: unknown, key?: string): unknown {
  if (key) {
    const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();

    if (REDACTED_KEYS.has(normalizedKey)) {
      return '[REDACTED]';
    }

    if (OMITTED_KEYS.has(normalizedKey)) {
      return '[OMITTED]';
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactVikunjaLogValue(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactVikunjaLogValue(entryValue, entryKey)
      ]),
    );
  }

  return value;
}

export function createSafeVikunjaLogger(sink: VikunjaLogSink): VikunjaLogSink {
  return (event) => sink(redactVikunjaLogValue(event) as VikunjaLogEvent);
}
