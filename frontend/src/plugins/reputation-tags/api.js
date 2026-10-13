import { request } from '../../utils/api.js';

export const reputationTagsApi = {
  getStatus: pluginId => request('GET', `/${pluginId}/status`),
  startBackfill: (pluginId, accountId) => request('POST', `/${pluginId}/accounts/${encodeURIComponent(accountId)}/backfill`),
  stopBackfill: (pluginId, accountId) => request('DELETE', `/${pluginId}/accounts/${encodeURIComponent(accountId)}/backfill`),
};
