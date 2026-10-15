import { request } from '../../src/utils/api.js';

export const pluginBackfillApi = {
  status: () => request('GET', '/plugins/backfill'),
  start: () => request('POST', '/plugins/backfill'),
};
