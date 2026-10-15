import {
  readJevSpamResults, readJevSpamMessage, isPluginActivated, jevStatus,
} from '../api.js';
import { PLUGIN_ID, SPAM_AT_LEAST, HAM_AT_MOST, storedSpamObservation } from './model.js';

const policy = { hamAtMost: HAM_AT_MOST, spamAtLeast: SPAM_AT_LEAST };
const publicMessage = ({ annotation, ...message }) => ({
  ...message, observation: storedSpamObservation(annotation, message.facets),
});

async function pluginState(userId) {
  const [activated, service] = await Promise.all([isPluginActivated(userId, PLUGIN_ID), jevStatus()]);
  let configuration;
  switch (service.kind) {
    case 'configured': configuration = 'enabled'; break;
    case 'unconfigured': configuration = 'unconfigured'; break;
    default: throw new Error(`unknown Jev service state ${service.kind}`);
  }
  return { id: PLUGIN_ID, kind: 'jev_spam', activated, configuration, ...policy };
}

function refusal(res, result) {
  switch (result.kind) {
    case 'ok': return false;
    case 'invalid': res.status(400).json({ error: result.error }); return true;
    case 'not_found': res.status(404).json({ error: 'Mail record or account not found' }); return true;
    default: throw new Error(`unknown stored result response ${result.kind}`);
  }
}

export function registerStoredResultRoutes(router) {
  router.get('/results', async (req, res) => {
    const result = await readJevSpamResults(req.session.userId, policy, req.query);
    if (refusal(res, result)) return;
    res.json({
      observedAt: result.observedAt, plugin: await pluginState(req.session.userId),
      accounts: result.accounts, counts: result.counts, messages: result.messages.map(publicMessage), nextCursor: result.nextCursor,
    });
  });
  router.get('/results/:messageId', async (req, res) => {
    const result = await readJevSpamMessage(req.session.userId, policy, req.params.messageId);
    if (refusal(res, result)) return;
    res.json({ observedAt: result.observedAt, plugin: await pluginState(req.session.userId), message: publicMessage(result.message) });
  });
}
