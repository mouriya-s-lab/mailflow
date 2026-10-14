import {
  readReputationResults, readReputationMessage, isPluginActivated, sourceStatus, NEW_DOMAIN_MAX_AGE_MS,
} from '../api.js';
import { storedReputationObservation } from './model.js';

function refusal(res, result) {
  switch (result.kind) {
    case 'ok': return false;
    case 'invalid': res.status(400).json({ error: result.error }); return true;
    case 'not_found': res.status(404).json({ error: 'Mail record or account not found' }); return true;
    default: throw new Error(`unknown stored result response ${result.kind}`);
  }
}

export function registerStoredResultRoutes(router, plugin) {
  const policy = { source: plugin.source, newDomainMaxAgeMs: NEW_DOMAIN_MAX_AGE_MS };
  const publicMessage = ({ annotation, ...message }) => ({
    ...message, observation: storedReputationObservation(plugin.source, annotation, message.facets),
  });
  async function pluginState(userId) {
    const [activated, configuration] = await Promise.all([
      isPluginActivated(userId, plugin.id), sourceStatus(plugin.source),
    ]);
    return plugin.source === 'rdap'
      ? { id: plugin.id, kind: 'rdap', source: plugin.source, activated, configuration, newDomainMaxAgeMs: NEW_DOMAIN_MAX_AGE_MS }
      : { id: plugin.id, kind: 'listing', source: plugin.source, activated, configuration };
  }
  router.get('/results', async (req, res) => {
    const result = await readReputationResults(req.session.userId, policy, req.query);
    if (refusal(res, result)) return;
    res.json({
      observedAt: result.observedAt, plugin: await pluginState(req.session.userId),
      accounts: result.accounts, counts: result.counts, messages: result.messages.map(publicMessage), nextCursor: result.nextCursor,
    });
  });
  router.get('/results/:messageId', async (req, res) => {
    const result = await readReputationMessage(req.session.userId, policy, req.params.messageId);
    if (refusal(res, result)) return;
    res.json({ observedAt: result.observedAt, plugin: await pluginState(req.session.userId), message: publicMessage(result.message) });
  });
}
