import { api } from '../../src/utils/api.js';
import { useStore } from '../../src/store/index.js';
import { applyMarkRead } from '../../src/utils/markRead.js';

/**
 * Open the exact physical row the user inspected. Unlike notification/GTD recovery, a missing
 * UUID must not resolve to another copy with the same Message-ID. Selection presentation is
 * temporary: the next normal selection again follows the user's conversation preference.
 * @returns {Promise<{kind:'opened'}|{kind:'superseded'}>}
 */
export async function openStoredResultMessage(messageId, { isCurrent = () => true } = {}) {
  if (!isCurrent()) return { kind: 'superseded' };
  const message = await api.getMessage(messageId);
  if (!isCurrent()) return { kind: 'superseded' };
  if (!message || message.id !== messageId) throw new Error('The requested mail record is no longer accessible');
  const store = useStore.getState();
  store.setSearchQuery('');
  store.setSelectedAccount(message.account_id, message.folder);
  store.setThreadMessages(`__dl_${message.id}`, [message]);
  store.setSelectedMessage(message.id, 'single');
  if (store.markReadBehavior !== 'manual') applyMarkRead(message);
  store.setShowAdmin(false);
  return { kind: 'opened' };
}
