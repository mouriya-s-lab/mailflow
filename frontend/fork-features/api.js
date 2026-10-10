import { request } from '../src/utils/api.js';

export const proxyApi = {
  startAccount: data => request('POST', '/accounts/proxy/start', data),
  completeAccount: (flowId, responseUrl) => request(
    'POST', `/accounts/proxy/${flowId}/complete`, { response_url: responseUrl },
  ),
  cancelAccount: flowId => request('DELETE', `/accounts/proxy/${flowId}`),
};
