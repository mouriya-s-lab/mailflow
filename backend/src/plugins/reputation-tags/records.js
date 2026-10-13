import { storage, getAccountConfig, setAccountConfig } from '../api.js';
import { parseFloors, parseBackfill } from './model.js';

// Tick, ensure and backfill commands hold the same plugin/account turn, so record writes cannot
// overwrite one another. Unlike a joining tick, an ensure or HTTP command must take its own turn.
const running = new Map();
export const turnKey = (pluginId, accountId) => `${pluginId}:${accountId}`;
export const currentTurn = (pluginId, accountId) => running.get(turnKey(pluginId, accountId));
export function exclusive(pluginId, accountId, fn) {
  const key = turnKey(pluginId, accountId);
  const previous = running.get(key) ?? Promise.resolve();
  const job = previous.then(fn);
  const tail = job.then(() => {}, () => {});
  running.set(key, tail);
  tail.then(() => { if (running.get(key) === tail) running.delete(key); });
  return job;
}

export async function loadFloors(pluginId, accountId) {
  const config = await getAccountConfig(pluginId, accountId);
  return parseFloors(config.newMailFloors ?? {});
}
export const saveFloors = (pluginId, accountId, newMailFloors) =>
  setAccountConfig(pluginId, accountId, { newMailFloors });
const backfillKey = accountId => `account:${accountId}:backfill`;
export const loadBackfill = async (pluginId, accountId) =>
  parseBackfill((await storage.getValue(pluginId, backfillKey(accountId)))?.value);
export const saveBackfill = (pluginId, accountId, userId, value) =>
  storage.put(pluginId, backfillKey(accountId), { value, ownerId: userId });

export async function recordProcessed(pluginId, accountId) {
  const stored = await storage.getValue(pluginId, backfillKey(accountId));
  const run = parseBackfill(stored?.value);
  if (run.kind === 'running') {
    await saveBackfill(pluginId, accountId, stored.owner_id, { ...run, processed: run.processed + 1 });
  }
}
