import { request } from '../../utils/api.js';

export const reputationTagsApi = {
  getStatus: pluginId => request('GET', `/${pluginId}/status`),
};
