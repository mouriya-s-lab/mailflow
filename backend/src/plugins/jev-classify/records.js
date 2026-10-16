// Jev classification plugin — its stored records.
//
// plugin_data keys (all owned by the account's user, so they are deleted with the user):
//   user:<userId>:categories        the category definition
//   user:<userId>:spam-instructions  the user's spam judgment prompt, { instructions } (null: the default)
//   account:<accountId>:backfill    the backfill run
//   account:<accountId>:incidents   moves the server made that MailFlow could not follow
//   account:<accountId>:stats       when Jev last decided a message of the account
// and the account configuration in plugin_account_config.
//
// The account configuration and the backfill run each have two writers: the HTTP routes (the
// user) and the sync tick (new-mail floors, run progress). Each read-modify-write runs through
// `serialized` on one key per record owner, so neither writer can overwrite the other with what
// it read before. That holds because one backend process serves the installation.

import { storage, getAccountConfig, setAccountConfig } from '../api.js';
import {
  PLUGIN_ID, storedCategories, storedSpamInstructions, spamInstructionsView, storedAccountConfig, storedBackfill, storedIncidents, storedStats,
} from './model.js';

const chains = new Map();

// Run `fn` after every earlier call with the same key has settled; resolves to its result.
export function serialized(key, fn) {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

const categoriesKey = userId => `user:${userId}:categories`;
const spamInstructionsKey = userId => `user:${userId}:spam-instructions`;
const backfillKey = accountId => `account:${accountId}:backfill`;
const incidentsKey = accountId => `account:${accountId}:incidents`;
const statsKey = accountId => `account:${accountId}:stats`;

const readValue = async key => (await storage.getValue(PLUGIN_ID, key))?.value ?? null;
const writeValue = (key, value, userId) => storage.put(PLUGIN_ID, key, { value, ownerId: userId });

// ── Categories ────────────────────────────────────────────────────────────────

export const loadCategories = async userId => storedCategories(await readValue(categoriesKey(userId)));

// Saves a new list as the next revision; resolves to that revision.
export function saveCategories(userId, categories) {
  return serialized(`user:${userId}`, async () => {
    const { revision } = await loadCategories(userId);
    const next = { revision: revision + 1, categories };
    await writeValue(categoriesKey(userId), next, userId);
    return next.revision;
  });
}

// ── Spam judgment prompt ──────────────────────────────────────────────────────

// The user's text, or null for the default; { instructions, custom } is what the routes and the tick use.
export const loadSpamInstructions = async userId =>
  spamInstructionsView(storedSpamInstructions(await readValue(spamInstructionsKey(userId))));

// Saves the user's text, or null to restore the default. One value, so it needs no serialized turn.
export const saveSpamInstructions = (userId, instructions) => writeValue(spamInstructionsKey(userId), { instructions }, userId);

// ── Account configuration ─────────────────────────────────────────────────────

export const loadAccountConfig = async accountId => storedAccountConfig(await getAccountConfig(PLUGIN_ID, accountId));

// fn(config) → { next: AccountConfig | null, result }; `next` is written when not null.
export function updateAccountConfig(accountId, fn) {
  return serialized(`account:${accountId}:config`, async () => {
    const { next, result } = await fn(await loadAccountConfig(accountId));
    if (next) await setAccountConfig(PLUGIN_ID, accountId, next);
    return result;
  });
}

// ── Backfill run ──────────────────────────────────────────────────────────────

export const loadBackfill = async accountId => storedBackfill(await readValue(backfillKey(accountId)));

// fn(run) → { next: BackfillRun | null, result }.
export function updateBackfill(accountId, userId, fn) {
  return serialized(`account:${accountId}:backfill`, async () => {
    const { next, result } = await fn(await loadBackfill(accountId));
    if (next) await writeValue(backfillKey(accountId), next, userId);
    return result;
  });
}

// ── Incidents ─────────────────────────────────────────────────────────────────

export const loadIncidents = async accountId => storedIncidents(await readValue(incidentsKey(accountId)));

export function appendIncident(accountId, userId, incident) {
  return serialized(`account:${accountId}:incidents`, async () => {
    const incidents = await loadIncidents(accountId);
    await writeValue(incidentsKey(accountId), { incidents: [...incidents, incident] }, userId);
  });
}

export function clearIncidents(accountId, userId) {
  return serialized(`account:${accountId}:incidents`, () => writeValue(incidentsKey(accountId), { incidents: [] }, userId));
}

// ── Statistics ────────────────────────────────────────────────────────────────

export const loadStats = async accountId => storedStats(await readValue(statsKey(accountId)));

export const recordLastDecision = (accountId, userId, decidedAt) =>
  writeValue(statsKey(accountId), { lastDecidedAt: decidedAt }, userId);
