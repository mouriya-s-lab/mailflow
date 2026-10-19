// Jev classification plugin — calls to its backend routes (/api/jev-classify,
// backend/src/plugins/jev-classify/routes.js).
import { request } from '../../utils/api.js';

const BASE = '/jev-classify';
const accountPath = id => `${BASE}/accounts/${encodeURIComponent(id)}`;

export const jevClassifyApi = {
  getCategories: () => request('GET', `${BASE}/categories`),
  saveCategories: categories => request('PUT', `${BASE}/categories`, { categories }),
  getSpamInstructions: () => request('GET', `${BASE}/spam-instructions`),
  saveSpamInstructions: instructions => request('PUT', `${BASE}/spam-instructions`, { instructions }),
  getAccounts: () => request('GET', `${BASE}/accounts`),
  saveAccount: (id, settings) => request('PUT', accountPath(id), settings),
  getStatus: () => request('GET', `${BASE}/status`),
  retryFailed: id => request('POST', `${accountPath(id)}/retry-failed`),
  clearIncidents: id => request('DELETE', `${accountPath(id)}/incidents`),
};
