import { describe, expect, it } from 'vitest';
import { bodyGate, failedAttempt, parseAnnotation, parseResult, refreshFloors } from './model.js';

const checkedAt = '2026-10-13T10:00:00.000Z';
const pending = { revision: 0, attempts: 0, queue: { state: 'pending', dueAt: null, origin: 'backfill' } };

describe('reputation snapshots and queue transitions', () => {
  it('stores unknown immediately, improves it through five attempts, and retains the final snapshot', () => {
    const result = { kind: 'complete', checkedAt, subjects: { 'example.com': { kind: 'unknown', reason: 'error' } } };
    let annotation = pending;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const now = new Date(checkedAt);
      annotation = failedAttempt(annotation, 'source_unknown', now, result);
      expect(annotation.result).toEqual(result);
      expect(annotation.attempts).toBe(attempt);
      expect(annotation.queue).toEqual({ state: attempt < 5 ? 'retry' : 'done', dueAt: attempt < 5 ? new Date(now.getTime() + 2 ** attempt * 60_000).toISOString() : null, origin: 'backfill' });
      expect(parseAnnotation('urlhaus', annotation)).toMatchObject({ result, attempts: attempt });
    }
  });

  it('keeps body deadline and provider failure distinct from an empty message', () => {
    expect(bodyGate({ kind: 'unavailable', reason: 'deadline' })).toBe('deadline');
    for (const reason of ['provider_refusing', 'imap_error', 'message_missing']) expect(bodyGate({ kind: 'unavailable', reason })).toBe('body_unavailable');
    expect(bodyGate({ kind: 'empty' })).toBe('ready');
    expect(() => bodyGate({ kind: 'unavailable', reason: 'anything_else' })).toThrow();
  });

  it('preserves source-native types and rejects unsafe or malformed URL snapshots', () => {
    expect(parseResult('rdap', { kind: 'complete', checkedAt, subjects: { 'example.com': { kind: 'known', registeredAt: checkedAt } } }).subjects['example.com'].kind).toBe('known');
    const digest = 'a'.repeat(64);
    const safe = { kind: 'complete', checkedAt, subjects: { [digest]: { host: 'example.com', verdict: { kind: 'listed', detail: 'phishing' } } } };
    expect(parseResult('safe_browsing', safe)).toEqual(safe);
    expect(() => parseResult('safe_browsing', { ...safe, subjects: { 'https://example.com/private': safe.subjects[digest] } })).toThrow();
    expect(() => parseResult('safe_browsing', { ...safe, subjects: { [digest]: { kind: 'listed', detail: 'phishing' } } })).toThrow();
    expect(() => parseResult('rdap', { kind: 'complete', checkedAt, subjects: { 'example.com': { kind: 'not_listed' } } })).toThrow();
  });

  it('keeps the original UID floor until UIDVALIDITY changes and preserves temporarily absent folders', () => {
    const old = { INBOX: { uidValidity: 1, nextUid: 10 }, Archive: { uidValidity: 3, nextUid: 100 } };
    expect(refreshFloors(old, { INBOX: { uidValidity: 1, nextUid: 50 } })).toEqual({ floors: old, changed: false });
    expect(refreshFloors(old, { INBOX: { uidValidity: 2, nextUid: 50 } })).toEqual({ floors: { ...old, INBOX: { uidValidity: 2, nextUid: 50 } }, changed: true });
  });
});
