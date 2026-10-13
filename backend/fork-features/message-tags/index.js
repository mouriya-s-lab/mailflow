// Message tags from the independent reputation plugins (mouriya-s-lab/mailflow#44).
//
// Four plugins — `tag-rdap`, `tag-spamhaus`, `tag-urlhaus`, `tag-safebrowsing` — each own one
// reputation source and store their result in their own namespace of a message's
// plugin_annotations. This module is how the rest of the system reads them: no consumer parses a
// plugin's namespace, and no consumer queries a reputation source itself.
//
// TagState, per source, for one message of an account:
//   { kind: 'inactive' }                      the user has not activated that plugin
//   { kind: 'unconfigured' }                  the source has no key, or is switched off
//   { kind: 'unchecked' }                     nothing is stored for this message yet
//                                             (getMessageTags only)
//   { kind: 'complete', checkedAt, subjects } what the plugin stored: the source's own domain
//                                             types (see fork-features/reputation), kept as they
//                                             are rather than flattened into a common verdict
//   { kind: 'unavailable', reason }            'deadline'   the plugin did not answer in time
//                                             'plugin_failed' its handler threw, or left this id
//                                             out of its answer (ensureMessageTags only)
//
// ensureMessageTags asks the plugins for a result and waits for it (a message that already has
// one is answered from its annotation, one that does not is looked up and stored now);
// getMessageTags answers from what is stored and contacts nothing. Both answer for every source
// on every id of the account; an id that is not a message of the account is absent from the Map.
// A plugin's failure or silence is that source's 'unavailable' and never hides another source.
//
// A tag is a snapshot with the time it was checked, not the source's current answer: nothing
// refreshes it on a schedule.

import { query } from '../../src/services/db.js';
import { logger } from '../../src/services/logger.js';
import { pluginRegistry } from '../../src/plugins/registry.js';

// The sources a tag plugin can own. A plugin declares one in its manifest's tagSource.
export const TAG_SOURCES = Object.freeze(['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing']);

// A registrable domain registered less than this long before a check is a new domain. The
// anti-spam link rules read it from here too, so the rules and the chips cannot drift apart.
export const NEW_DOMAIN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
// One summary request covers the messages a list shows; K7 caps a queue page at 200 as well.
const MAX_SUMMARY_IDS = 200;

const INACTIVE = Object.freeze({ kind: 'inactive' });
const PLUGIN_FAILED = Object.freeze({ kind: 'unavailable', reason: 'plugin_failed' });
const DEADLINE = Object.freeze({ kind: 'unavailable', reason: 'deadline' });

function parseArgs(accountId, messageIds) {
  if (typeof accountId !== 'string' || !accountId) throw new TypeError('accountId must be a non-empty string');
  if (!Array.isArray(messageIds)) throw new TypeError('messageIds must be an array');
  messageIds.forEach((id, i) => {
    if (typeof id !== 'string' || !id) throw new TypeError(`messageIds[${i}] must be a non-empty string`);
  });
  return { accountId, ids: [...new Set(messageIds)] };
}

// A source's subjects hold that source's own type: RDAP a Registration, Spamhaus DBL and URLhaus a
// SourceVerdict, and Safe Browsing, which is about one link URL rather than one domain, the
// { host, verdict } the plugin stores per URL digest.
function verdictOf(source, entry) {
  return source === 'safe_browsing' ? entry?.verdict : entry;
}

/**
 * The chips a message's tags are worth showing for: a domain some source lists, a domain
 * registered within NEW_DOMAIN_MAX_AGE_MS, or a source whose check could not tell. Everything
 * else — not listed, an older domain, nothing checked, a source that is off — is not a chip.
 *
 * @param {Record<string, object>} record one message's TagState per source
 * @param {number} at the time the chips are made for, in ms
 * @returns {Array<{ kind: 'listed', source: string }
 *   | { kind: 'new_domain', domain: string, ageDays: number }
 *   | { kind: 'unknown', source: string }>}
 */
export function tagChips(record, at) {
  const chips = [];
  for (const source of TAG_SOURCES) {
    const state = record?.[source];
    if (!state || state.kind !== 'complete') continue;
    let listed = false;
    let unknown = false;
    for (const [subject, entry] of Object.entries(state.subjects || {})) {
      const verdict = verdictOf(source, entry);
      if (source === 'rdap') {
        switch (verdict?.kind) {
          case 'known': {
            const age = at - Date.parse(verdict.registeredAt);
            if (!(age >= 0)) unknown = true;
            else if (age < NEW_DOMAIN_MAX_AGE_MS) chips.push({ kind: 'new_domain', domain: subject, ageDays: Math.floor(age / DAY_MS) });
            break;
          }
          case 'not_found':
            break;
          case 'unknown':
            unknown = true;
            break;
          default:
            throw new Error(`unhandled registration kind ${verdict?.kind}`);
        }
        continue;
      }
      switch (verdict?.kind) {
        case 'listed': listed = true; break;
        case 'not_listed':
        case 'unconfigured': break;
        case 'unknown': unknown = true; break;
        default: throw new Error(`unhandled verdict kind ${verdict?.kind}`);
      }
    }
    if (listed) chips.push({ kind: 'listed', source });
    if (unknown) chips.push({ kind: 'unknown', source });
  }
  return chips;
}

// A TagState without the checked subjects: what a list or a detail view may hold on to, with no
// URL and no domain in it.
function stateSummary(source, state) {
  switch (state.kind) {
    case 'complete': {
      const verdicts = Object.values(state.subjects || {}).map(entry => verdictOf(source, entry));
      return {
        kind: 'complete',
        checkedAt: state.checkedAt,
        subjects: verdicts.length,
        listed: verdicts.filter(v => v?.kind === 'listed').length,
        unknown: verdicts.filter(v => v?.kind === 'unknown').length,
      };
    }
    case 'inactive':
    case 'unconfigured':
    case 'unchecked':
      return { kind: state.kind };
    case 'unavailable':
      return { kind: 'unavailable', reason: state.reason };
    default:
      throw new Error(`unhandled tag state ${state.kind}`);
  }
}

// The modules that mock the services partially look their dependencies up per call, so each one
// is a parameter here rather than bound at import.
export function createMessageTags({ registry = pluginRegistry, queryFn = (...args) => query(...args), now = () => Date.now() } = {}) {
  // The registered tag plugins, one per source. A source nobody registered has no plugin, which
  // reads as 'inactive' like a plugin the user has not activated.
  function tagPlugins() {
    const out = [];
    for (const plugin of registry.list()) {
      const tag = plugin.tagSource;
      if (!tag) continue;
      if (!TAG_SOURCES.includes(tag.source)) {
        throw new Error(`plugin ${plugin.id}: unknown tag source ${JSON.stringify(tag.source)}`);
      }
      out.push({ pluginId: plugin.id, source: tag.source, ensure: tag.ensure, read: tag.read });
    }
    return out;
  }

  // Answer a plugin never gives: 'deadline' when it did not answer in time, 'failed' when it
  // threw. A late answer is dropped, not awaited — the caller's deadline is the caller's, and the
  // request it started is left to finish on its own. Without a deadline (a stored read) the
  // answer is simply awaited. Every non-answer is logged: a plugin that stops answering must not
  // look like one that has nothing to say.
  async function answerOf(plugin, label, call, ids, deadlineAt) {
    const answer = Promise.resolve()
      .then(call)
      .then(map => ({ kind: 'answered', map }), err => ({ kind: 'failed', error: err }));
    let outcome;
    if (deadlineAt === null) {
      outcome = await answer;
    } else {
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        outcome = { kind: 'deadline' };
      } else {
        let timer;
        const late = new Promise(resolve => {
          timer = setTimeout(() => resolve({ kind: 'deadline' }), remaining);
        });
        outcome = await Promise.race([answer, late]).finally(() => clearTimeout(timer));
      }
    }
    switch (outcome.kind) {
      case 'deadline':
        logger.warn(`[message-tags] ${plugin.pluginId} ${label} did not answer in time`);
        break;
      case 'failed':
        logger.warn(`[message-tags] ${plugin.pluginId} ${label} failed: ${outcome.error?.message ?? outcome.error}`);
        break;
      case 'answered':
        if (!(outcome.map instanceof Map)) {
          logger.warn(`[message-tags] ${plugin.pluginId} ${label} answered with ${typeof outcome.map} instead of a Map`);
        } else if (ids.some(id => !outcome.map.has(id))) {
          logger.warn(`[message-tags] ${plugin.pluginId} ${label} left some of ${ids.length} message(s) out of its answer`);
        }
        break;
      default:
        throw new Error(`unhandled plugin answer ${outcome.kind}`);
    }
    return outcome;
  }

  // One record per requested id, every source present whatever any single plugin did.
  async function dispatch(plugins, accountId, ids, kind, deadlineAt) {
    const answers = new Map();
    await Promise.all(plugins.map(async plugin => {
      const options = kind === 'ensure'
        ? { deadlineMs: deadlineAt === null ? 0 : Math.max(0, deadlineAt - now()) }
        : undefined;
      const call = () => (kind === 'ensure' ? plugin.ensure(accountId, ids, options) : plugin.read(accountId, ids));
      answers.set(plugin.source, await answerOf(plugin, kind, call, ids, deadlineAt));
    }));
    const out = new Map();
    for (const id of ids) {
      const record = {};
      for (const source of TAG_SOURCES) {
        const answer = answers.get(source);
        if (!answer) record[source] = INACTIVE;
        else if (answer.kind === 'deadline') record[source] = DEADLINE;
        else if (answer.kind === 'failed') record[source] = PLUGIN_FAILED;
        else record[source] = answer.map instanceof Map ? (answer.map.get(id) ?? PLUGIN_FAILED) : PLUGIN_FAILED;
      }
      out.set(id, record);
    }
    return out;
  }

  // Only the ids that really are messages of this account; a foreign or unknown id is absent.
  async function ownedIds(accountId, ids) {
    if (ids.length === 0) return [];
    const { rows } = await queryFn(
      'SELECT id FROM messages WHERE account_id = $1 AND id = ANY($2::uuid[])',
      [accountId, ids],
    );
    const present = new Set(rows.map(row => row.id));
    return ids.filter(id => present.has(id));
  }

  /**
   * ensureMessageTags(accountId, messageIds, { deadlineMs }) → Map<id, Record<TagSource, TagState>>
   * Asks every tag plugin for these messages and waits, up to deadlineMs from the call, for the
   * answers. Database errors are thrown.
   */
  async function ensureMessageTags(accountId, messageIds, options) {
    const { deadlineMs } = options || {};
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new TypeError('deadlineMs must be a non-negative number');
    // The deadline counts from the call, so it is fixed before this function's own queries: the
    // time they take comes out of the caller's budget, not out of thin air.
    const deadlineAt = now() + deadlineMs;
    const { ids } = parseArgs(accountId, messageIds);
    const owned = await ownedIds(accountId, ids);
    if (owned.length === 0) return new Map();
    return dispatch(tagPlugins(), accountId, owned, 'ensure', deadlineAt);
  }

  /**
   * getMessageTags(accountId, messageIds) → Map<id, Record<TagSource, TagState>>
   * What is stored now, with no external query and no wait: a message the plugins have not looked
   * at is 'unchecked'.
   */
  async function getMessageTags(accountId, messageIds) {
    const { ids } = parseArgs(accountId, messageIds);
    const owned = await ownedIds(accountId, ids);
    if (owned.length === 0) return new Map();
    return dispatch(tagPlugins(), accountId, owned, 'read', null);
  }

  /**
   * summarizeForUser(userId, ids) → { kind: 'ok', tags } | { kind: 'invalid', error }
   * The chips and the per-source state of the caller's own messages, for the mail list and the
   * message view. Ids of another user's messages are simply not in the answer.
   */
  async function summarizeForUser(userId, ids) {
    if (typeof userId !== 'string' || !userId) throw new TypeError('userId must be a non-empty string');
    if (!Array.isArray(ids)) return { kind: 'invalid', error: 'ids must be an array' };
    if (ids.some(id => typeof id !== 'string' || !id)) return { kind: 'invalid', error: 'ids must be an array of message ids' };
    const unique = [...new Set(ids)];
    if (unique.length > MAX_SUMMARY_IDS) return { kind: 'invalid', error: `at most ${MAX_SUMMARY_IDS} ids per request` };
    if (unique.length === 0) return { kind: 'ok', tags: {} };

    const { rows } = await queryFn(
      `SELECT m.id, m.account_id
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
        WHERE a.user_id = $1 AND m.id = ANY($2::uuid[])`,
      [userId, unique],
    );
    const byAccount = new Map();
    for (const row of rows) {
      if (!byAccount.has(row.account_id)) byAccount.set(row.account_id, []);
      byAccount.get(row.account_id).push(row.id);
    }

    const at = now();
    const tags = {};
    for (const [accountId, accountIds] of byAccount) {
      const states = await getMessageTags(accountId, accountIds);
      for (const id of accountIds) {
        const record = states.get(id);
        if (!record) continue;
        tags[id] = {
          notable: tagChips(record, at),
          sources: Object.fromEntries(TAG_SOURCES.map(source => [source, stateSummary(source, record[source])])),
        };
      }
    }
    return { kind: 'ok', tags };
  }

  return { ensureMessageTags, getMessageTags, summarizeForUser };
}

const messageTags = createMessageTags();

export const ensureMessageTags = messageTags.ensureMessageTags;
export const getMessageTags = messageTags.getMessageTags;
export const summarizeForUser = messageTags.summarizeForUser;
