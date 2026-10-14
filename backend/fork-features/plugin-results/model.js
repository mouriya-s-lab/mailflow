import { isUuid } from '../../src/utils/uuid.js';

/** @typedef {'jev_spam'|'rdap'|'listing'} StoredResultKind */
/** @typedef {{kind:'all'}|{kind:'account',accountId:string}} StoredResultScope */
/** @typedef {{kind:'start'}|{kind:'after',date:string|null,id:string}} StoredResultPosition */
/** @typedef {{scope:StoredResultScope,facet:string,limit:number,position:StoredResultPosition}} StoredResultQuery */

const COMMON = ['all', 'checked', 'not_checked', 'unrecognized'];
export const RESULT_FACETS = Object.freeze({
  jev_spam: Object.freeze([...COMMON, 'spam', 'ham', 'uncertain', 'pending', 'retry', 'failed', 'disabled']),
  rdap: Object.freeze([...COMMON, 'registered', 'new_domain', 'not_found', 'unknown', 'no_links']),
  listing: Object.freeze([...COMMON, 'listed', 'not_listed', 'unknown', 'no_links']),
});
export const MAX_RESULT_PAGE = 200;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = error => ({ kind: 'invalid', error });
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/**
 * Parse HTTP query input once; a cursor belongs to exactly one plugin/account/facet selection.
 * @returns {{kind:'ok',query:StoredResultQuery}|{kind:'invalid',error:string}}
 */
export function parseResultQuery(kind, pluginId, input) {
  const facets = RESULT_FACETS[kind];
  if (!facets) throw new TypeError(`unknown stored result kind ${kind}`);
  if (!record(input)) return invalid('query must be an object');
  const facet = input.facet === undefined ? 'all' : input.facet;
  if (typeof facet !== 'string' || !facets.includes(facet)) return invalid('invalid result facet');
  let scope;
  if (input.accountId === undefined) scope = { kind: 'all' };
  else if (typeof input.accountId === 'string' && isUuid(input.accountId)) scope = { kind: 'account', accountId: input.accountId };
  else return invalid('accountId must be an account UUID');
  const rawLimit = input.limit === undefined ? '50' : input.limit;
  if (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit)) return invalid('limit must be a positive integer');
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > MAX_RESULT_PAGE) return invalid(`limit must be at most ${MAX_RESULT_PAGE}`);
  let position = { kind: 'start' };
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.cursor) || input.cursor.length > 1000) return invalid('invalid result cursor');
    let cursor;
    try {
      const decoded = Buffer.from(input.cursor, 'base64url');
      if (decoded.toString('base64url') !== input.cursor) return invalid('invalid result cursor');
      cursor = JSON.parse(decoded.toString('utf8'));
    } catch { return invalid('invalid result cursor'); }
    const accountId = scope.kind === 'account' ? scope.accountId : null;
    if (!record(cursor) || cursor.version !== 1 || cursor.pluginId !== pluginId || cursor.accountId !== accountId || cursor.facet !== facet
      || !isUuid(cursor.id) || !(cursor.date === null || isoTime(cursor.date))) return invalid('cursor does not match this result selection');
    position = { kind: 'after', date: cursor.date, id: cursor.id };
  }
  return { kind: 'ok', query: { scope, facet, limit, position } };
}

export function resultCursor(pluginId, query, row) {
  return Buffer.from(JSON.stringify({
    version: 1, pluginId, accountId: query.scope.kind === 'account' ? query.scope.accountId : null,
    facet: query.facet, date: row.date, id: row.id,
  })).toString('base64url');
}
