// Stored inspection is deliberately separate from live tag reads: it exposes saved observations
// on current physical mail rows, even while a producer is disabled. It never calls a producer.
import { query } from '../../src/services/db.js';
import { isUuid } from '../../src/utils/uuid.js';
import { tagSourcePlugins } from '../message-tags/index.js';
import { RESULT_FACETS, parseResultQuery, resultCursor } from './model.js';

/** @typedef {{hamAtMost:number,spamAtLeast:number}} JevResultPolicy */
/** @typedef {{source:'rdap'|'spamhaus_dbl'|'urlhaus'|'safe_browsing',newDomainMaxAgeMs:number}} ReputationResultPolicy */
/** @typedef {{id:string,accountId:string,accountEmail:string,folder:string,uid:number,subject:string|null,fromName:string|null,fromEmail:string|null,date:string|null,facets:string[],annotation:unknown}} StoredAnnotationRow */

const SOURCES = ['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing'];
const stringAt = value => `(jsonb_typeof(${value}) = 'string')`;
const numberAt = value => `(CASE WHEN jsonb_typeof(${value}) = 'number' THEN (${value} #>> '{}')::numeric END)`;
const countAt = value => `(${numberAt(value)} BETWEEN 0 AND 9007199254740991 AND ${numberAt(value)} = trunc(${numberAt(value)}))`;
// Producers write ISO timestamps. A damaged or unrecognized saved value must not abort a whole
// account scan or silently become a negative answer. pg_input_is_valid keeps casts bounded.
const timeAt = value => `(CASE WHEN ${stringAt(value)} AND (${value} #>> '{}') ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$'
  AND pg_input_is_valid(${value} #>> '{}', 'timestamp with time zone')
  THEN (${value} #>> '{}')::timestamptz END)`;
const UNKNOWN_REASONS = "('timeout','rate_limited','error')";

function jevProjection() {
  const probability = numberAt("d -> 'probability'");
  const decisionDone = `(${probability} BETWEEN 0 AND 1 AND ${stringAt("d -> 'model'")} AND ${timeAt("d -> 'decidedAt'")} IS NOT NULL)`;
  const retry = `(${countAt("d -> 'attempts'")} AND ${stringAt("d -> 'errorKind'")} AND length(d ->> 'errorKind') > 0 AND ${timeAt("d -> 'dueAt'")} IS NOT NULL)`;
  return `
    decisions AS (
      SELECT id, date, annotation, annotation -> 'spam' AS spam_line,
             annotation #> '{spam,decision}' AS d FROM scoped
    ),
    projected AS MATERIALIZED (
      SELECT id, date,
        CASE
          WHEN annotation IS NULL OR annotation = 'null'::jsonb THEN ARRAY['not_checked']
          WHEN jsonb_typeof(annotation) <> 'object' THEN ARRAY['not_checked','unrecognized']
          WHEN spam_line IS NULL OR spam_line = 'null'::jsonb THEN ARRAY['not_checked']
          WHEN jsonb_typeof(spam_line) <> 'object' OR jsonb_typeof(d) IS DISTINCT FROM 'object' THEN ARRAY['not_checked','unrecognized']
          WHEN d ->> 'kind' = 'done' AND ${decisionDone} THEN ARRAY['checked',
            CASE WHEN ${probability} >= policy.spam THEN 'spam'
                 WHEN ${probability} <= policy.ham THEN 'ham' ELSE 'uncertain' END]
          WHEN d ->> 'kind' = 'pending' THEN ARRAY['not_checked','pending']
          WHEN d ->> 'kind' = 'retry' AND ${retry} THEN ARRAY['not_checked','retry']
          WHEN d ->> 'kind' = 'terminal_failed' AND ${stringAt("d -> 'errorKind'")} AND length(d ->> 'errorKind') > 0 THEN ARRAY['not_checked','failed']
          WHEN d ->> 'kind' = 'skipped' AND d ->> 'reason' = 'disabled' THEN ARRAY['not_checked','disabled']
          ELSE ARRAY['not_checked','unrecognized']
        END AS facets
      FROM decisions CROSS JOIN policy
    )`;
}

function reputationProjection(source) {
  const rdap = source === 'rdap';
  const safeBrowsing = source === 'safe_browsing';
  const value = safeBrowsing ? "entry.value -> 'verdict'" : 'entry.value';
  const registeredAt = timeAt("v -> 'registeredAt'");
  const checkedAt = timeAt("r -> 'checkedAt'");
  const validVerdict = rdap
    ? `(jsonb_typeof(v) = 'object' AND (
         (v ->> 'kind' = 'known' AND ${registeredAt} IS NOT NULL)
         OR v ->> 'kind' = 'not_found'
         OR (v ->> 'kind' = 'unknown' AND v ->> 'reason' IN ('timeout','rate_limited','error','unsupported_tld'))))`
    : `(jsonb_typeof(v) = 'object' AND (
         (v ->> 'kind' = 'listed' AND ${stringAt("v -> 'detail'")})
         OR v ->> 'kind' = 'not_listed'
         OR (v ->> 'kind' = 'unknown' AND v ->> 'reason' IN ${UNKNOWN_REASONS})))`;
  const validSubject = safeBrowsing
    ? `(entry.key ~ '^[0-9a-f]{64}$' AND jsonb_typeof(entry.value) = 'object' AND ${stringAt("entry.value -> 'host'")} AND length(entry.value ->> 'host') > 0)`
    : 'true';
  const facts = rdap
    ? `COALESCE(bool_or(v ->> 'kind' = 'known'), false) AS registered,
       COALESCE(bool_or(v ->> 'kind' = 'not_found'), false) AS not_found,
       COALESCE(bool_or(v ->> 'kind' = 'known' AND ${registeredAt} <= ${checkedAt}
         AND ${registeredAt} > ${checkedAt} - policy.new_window_ms * INTERVAL '1 millisecond'), false) AS new_domain,
       COALESCE(bool_or(v ->> 'kind' = 'unknown' OR (v ->> 'kind' = 'known' AND ${registeredAt} > ${checkedAt})), false) AS unknown`
    : `COALESCE(bool_or(v ->> 'kind' = 'listed'), false) AS listed,
       COALESCE(bool_and(v ->> 'kind' = 'not_listed'), false) AS not_listed,
       COALESCE(bool_or(v ->> 'kind' = 'unknown'), false) AS unknown`;
  const facets = rdap
    ? "CASE WHEN subjects.registered THEN 'registered' END, CASE WHEN subjects.new_domain THEN 'new_domain' END, CASE WHEN subjects.not_found THEN 'not_found' END, CASE WHEN subjects.unknown THEN 'unknown' END"
    : "CASE WHEN subjects.listed THEN 'listed' END, CASE WHEN subjects.n > 0 AND subjects.not_listed THEN 'not_listed' END, CASE WHEN subjects.unknown THEN 'unknown' END";
  return `
    snapshots AS (
      SELECT id, date, annotation, annotation -> 'result' AS r FROM scoped
    ),
    projected AS MATERIALIZED (
      SELECT id, date,
        CASE
          WHEN annotation IS NULL OR annotation = 'null'::jsonb THEN ARRAY['not_checked']
          WHEN jsonb_typeof(annotation) <> 'object' THEN ARRAY['not_checked','unrecognized']
          WHEN r IS NULL OR r = 'null'::jsonb THEN ARRAY['not_checked']
          WHEN jsonb_typeof(r) IS DISTINCT FROM 'object' OR r ->> 'kind' IS DISTINCT FROM 'complete'
            OR ${checkedAt} IS NULL OR jsonb_typeof(r -> 'subjects') IS DISTINCT FROM 'object'
            OR NOT subjects.valid THEN ARRAY['not_checked','unrecognized']
          ELSE array_remove(ARRAY['checked', CASE WHEN subjects.n = 0 THEN 'no_links' END, ${facets}], NULL)
        END AS facets
      FROM snapshots CROSS JOIN policy
      CROSS JOIN LATERAL (
        SELECT count(*) AS n, COALESCE(bool_and(COALESCE(${validVerdict} AND ${validSubject}, false)), true) AS valid,
          ${facts}
        FROM jsonb_each(CASE WHEN jsonb_typeof(r -> 'subjects') = 'object' THEN r -> 'subjects' ELSE '{}'::jsonb END) AS entry
        CROSS JOIN LATERAL (SELECT ${value} AS v) AS verdict
      ) AS subjects
    )`;
}

function statement(projection) {
  return `WITH
    policy AS (SELECT $10::numeric AS ham, $11::numeric AS spam, $12::double precision AS new_window_ms),
    owned_accounts AS MATERIALIZED (
      SELECT id, email_address FROM email_accounts WHERE user_id = $1
    ),
    selected_accounts AS (
      SELECT * FROM owned_accounts WHERE $3::uuid IS NULL OR id = $3::uuid
    ),
    scoped AS (
      SELECT m.id, m.date, m.plugin_annotations -> $2::text AS annotation
      FROM messages m JOIN selected_accounts a ON a.id = m.account_id
      WHERE m.is_deleted = false AND ($4::uuid IS NULL OR m.id = $4::uuid)
    ),
    ${projection},
    facet_counts AS (
      SELECT facet, count(*)::integer AS n FROM projected
      CROSS JOIN LATERAL unnest(ARRAY['all'] || facets) AS f(facet)
      GROUP BY facet
    ),
    candidates AS MATERIALIZED (
      SELECT id, date, facets FROM projected
      WHERE ($8::text = 'all' OR $8::text = ANY(facets))
        AND (NOT $5::boolean OR
          ($6::timestamptz IS NOT NULL AND (date < $6::timestamptz OR date IS NULL OR (date = $6::timestamptz AND id < $7::uuid))) OR
          ($6::timestamptz IS NULL AND date IS NULL AND id < $7::uuid))
      ORDER BY date DESC NULLS LAST, id DESC LIMIT ($9::integer + 1)
    ),
    visible AS (
      SELECT * FROM candidates ORDER BY date DESC NULLS LAST, id DESC LIMIT $9::integer
    )
    SELECT statement_timestamp() AS observed_at,
      EXISTS(SELECT 1 FROM selected_accounts) AS account_exists,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'emailAddress', email_address) ORDER BY email_address, id), '[]'::jsonb) FROM owned_accounts) AS accounts,
      (SELECT jsonb_agg(jsonb_build_object('facet', names.facet, 'count', COALESCE(c.n, 0)) ORDER BY names.position)
         FROM unnest($13::text[]) WITH ORDINALITY AS names(facet, position)
         LEFT JOIN facet_counts c ON c.facet = names.facet) AS counts,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', m.id, 'accountId', m.account_id, 'accountEmail', a.email_address,
        'folder', m.folder, 'uid', m.uid, 'subject', m.subject,
        'fromName', m.from_name, 'fromEmail', m.from_email, 'date', m.date,
        'facets', p.facets, 'annotation', m.plugin_annotations -> $2::text
      ) ORDER BY p.date DESC NULLS LAST, p.id DESC), '[]'::jsonb)
       FROM visible p JOIN messages m ON m.id = p.id JOIN owned_accounts a ON a.id = m.account_id) AS messages,
      (SELECT count(*) > $9::integer FROM candidates) AS has_more`;
}

const JEV_STATEMENT = statement(jevProjection());
const REPUTATION_STATEMENTS = Object.fromEntries(SOURCES.map(source => [source, statement(reputationProjection(source))]));

function jevPolicy(value) {
  if (!value || !Number.isFinite(value.hamAtMost) || !Number.isFinite(value.spamAtLeast)
    || value.hamAtMost < 0 || value.spamAtLeast > 1 || value.hamAtMost >= value.spamAtLeast) throw new TypeError('invalid Jev result policy');
  return { kind: 'jev_spam', pluginId: 'jev-classify', ham: value.hamAtMost, spam: value.spamAtLeast, newWindowMs: 0, sql: JEV_STATEMENT };
}

const asIso = value => value === null ? null : new Date(value).toISOString();

export function createStoredResultReader({ queryFn = (...args) => query(...args), tagSourcePluginsFn = tagSourcePlugins } = {}) {
  function reputationPolicy(value) {
    if (!value || !SOURCES.includes(value.source) || !Number.isFinite(value.newDomainMaxAgeMs) || value.newDomainMaxAgeMs <= 0) throw new TypeError('invalid reputation result policy');
    const pluginId = tagSourcePluginsFn()[value.source];
    if (!pluginId) return null;
    return { kind: value.source === 'rdap' ? 'rdap' : 'listing', pluginId, ham: 0, spam: 1, newWindowMs: value.newDomainMaxAgeMs, sql: REPUTATION_STATEMENTS[value.source] };
  }

  async function read(userId, policy, input, messageId = null) {
    if (typeof userId !== 'string' || !isUuid(userId)) throw new TypeError('userId must be a user UUID');
    if (!policy) return { kind: 'not_found' };
    const parsed = parseResultQuery(policy.kind, policy.pluginId, input);
    if (parsed.kind === 'invalid') return parsed;
    const { query: selection } = parsed;
    const { position } = selection;
    const { rows: [row] } = await queryFn(policy.sql, [
      userId, policy.pluginId, selection.scope.kind === 'account' ? selection.scope.accountId : null,
      messageId, position.kind === 'after', position.kind === 'after' ? position.date : null,
      position.kind === 'after' ? position.id : null, selection.facet, selection.limit,
      policy.ham, policy.spam, policy.newWindowMs, RESULT_FACETS[policy.kind],
    ]);
    if ((selection.scope.kind === 'account' && !row.account_exists) || (messageId !== null && row.messages.length === 0)) return { kind: 'not_found' };
    const messages = row.messages.map(message => ({ ...message, date: asIso(message.date) }));
    const nextCursor = row.has_more ? resultCursor(policy.pluginId, selection, messages.at(-1)) : null;
    return { kind: 'ok', observedAt: asIso(row.observed_at), accounts: row.accounts, counts: row.counts, messages, nextCursor };
  }

  const detail = async (userId, policy, messageId) => {
    if (typeof messageId !== 'string' || !isUuid(messageId)) return { kind: 'invalid', error: 'messageId must be a message UUID' };
    const result = await read(userId, policy, {}, messageId);
    if (result.kind !== 'ok') return result;
    return { kind: 'ok', observedAt: result.observedAt, message: result.messages[0] };
  };

  return {
    readJevSpamResults: (userId, policy, input) => read(userId, jevPolicy(policy), input),
    readReputationResults: (userId, policy, input) => read(userId, reputationPolicy(policy), input),
    readJevSpamMessage: (userId, policy, messageId) => detail(userId, jevPolicy(policy), messageId),
    readReputationMessage: (userId, policy, messageId) => detail(userId, reputationPolicy(policy), messageId),
  };
}

const reader = createStoredResultReader();
export const readJevSpamResults = reader.readJevSpamResults;
export const readReputationResults = reader.readReputationResults;
export const readJevSpamMessage = reader.readJevSpamMessage;
export const readReputationMessage = reader.readReputationMessage;
