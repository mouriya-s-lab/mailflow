import { describe, expect, it } from 'vitest';
import { parseResultQuery, resultCursor } from './model.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';

const query = (kind, pluginId, input) => {
  const parsed = parseResultQuery(kind, pluginId, input);
  expect(parsed.kind).toBe('ok');
  return parsed.query;
};

describe('stored result query parsing', () => {

  it('accepts a UUID account scope, a closed facet, and the maximum page size', () => {
    expect(parseResultQuery('jev_spam', 'jev-classify', {
      accountId: ACCOUNT, facet: 'uncertain', limit: '200',
    })).toEqual({
      kind: 'ok',
      query: { scope: { kind: 'account', accountId: ACCOUNT }, facet: 'uncertain', limit: 200, position: { kind: 'start' } },
    });
  });

  it.each([
    null,
    [],
    { facet: 'not-a-facet' },
    { facet: 'listed' },
    { accountId: null },
    { accountId: 'not-a-uuid' },
    { limit: '' },
    { limit: '0' },
    { limit: '1.5' },
    { limit: '201' },
    { limit: 10 },
  ])('rejects %j', input => {
    const parsed = parseResultQuery('rdap', 'tag-rdap', input);
    expect(parsed.kind).toBe('invalid');
    expect(parsed.error).toEqual(expect.any(String));
  });

  it('accepts a cursor at the null-date boundary and round-trips its selection', () => {
    const start = query('rdap', 'tag-rdap', { accountId: ACCOUNT, facet: 'not_found', limit: '3' });
    const cursor = resultCursor('tag-rdap', start, { date: null, id: MESSAGE });
    expect(parseResultQuery('rdap', 'tag-rdap', {
      accountId: ACCOUNT, facet: 'not_found', limit: '3', cursor,
    })).toEqual({
      kind: 'ok',
      query: {
        scope: { kind: 'account', accountId: ACCOUNT }, facet: 'not_found', limit: 3,
        position: { kind: 'after', date: null, id: MESSAGE },
      },
    });
  });

  it('accepts a canonical timestamp cursor', () => {
    const parsed = query('jev_spam', 'jev-classify', { facet: 'spam' });
    const cursor = resultCursor('jev-classify', parsed, {
      date: '2026-10-13T12:34:56.789Z', id: MESSAGE,
    });
    expect(parseResultQuery('jev_spam', 'jev-classify', { facet: 'spam', cursor }).query.position).toEqual({
      kind: 'after', date: '2026-10-13T12:34:56.789Z', id: MESSAGE,
    });
  });

  it('rejects malformed, non-canonical, and selection-crossing cursors', () => {
    const parsed = query('jev_spam', 'jev-classify', { accountId: ACCOUNT, facet: 'spam' });
    const cursor = resultCursor('jev-classify', parsed, {
      date: '2026-10-13T12:34:56.789Z', id: MESSAGE,
    });
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

    const invalid = input => {
      const result = parseResultQuery('jev_spam', 'jev-classify', input);
      expect(result.kind).toBe('invalid');
      expect(result.error).toEqual(expect.any(String));
    };
    invalid({ accountId: ACCOUNT, facet: 'ham', cursor });
    invalid({ accountId: '33333333-3333-4333-8333-333333333333', facet: 'spam', cursor });
    invalid({ accountId: ACCOUNT, facet: 'spam', cursor: resultCursor('other-plugin', parsed, { date: '2026-10-13T12:34:56.789Z', id: MESSAGE }) });
    invalid({ accountId: ACCOUNT, facet: 'spam', cursor: 'not-base64!' });
    invalid({
      accountId: ACCOUNT, facet: 'spam', cursor: encode({ ...decoded, date: '2026-10-13T12:34:56Z' }),
    });
    invalid({
      accountId: ACCOUNT, facet: 'spam', cursor: encode({ ...decoded, id: 'not-a-uuid' }),
    });
  });
});
