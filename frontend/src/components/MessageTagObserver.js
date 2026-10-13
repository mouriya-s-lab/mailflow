import { useEffect } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

export default function MessageTagObserver() {
  const { visibleMessageTagIds, showMessageTags, messageTagsPreferencesLoaded, messagesRefreshToken, user } = useStore();
  const key = JSON.stringify(Object.keys(visibleMessageTagIds).sort());
  useEffect(() => {
    const ids = JSON.parse(key);
    if (!user?.id || !messageTagsPreferencesLoaded || !showMessageTags || !ids.length) {
      useStore.setState({ messageTagLookup: { kind: 'ready', tags: {} } });
      return;
    }
    let active = true;
    const current = () => {
      const state = useStore.getState();
      return active && state.user?.id === user.id && state.messageTagsPreferencesLoaded && state.showMessageTags
        && JSON.stringify(Object.keys(state.visibleMessageTagIds).sort()) === key;
    };
    useStore.setState({ messageTagLookup: { kind: 'loading' } });
    const load = async () => {
      const tags = {};
      try {
        for (let start = 0; start < ids.length; start += 200) {
          if (!current()) return;
          const result = await api.post('/message-tags/summary', { ids: ids.slice(start, start + 200) });
          if (!current()) return;
          Object.assign(tags, result.tags);
        }
        if (current()) useStore.setState({ messageTagLookup: { kind: 'ready', tags } });
      } catch (error) {
        if (!current()) return;
        console.error('Failed to load message tags:', error);
        useStore.setState({ messageTagLookup: { kind: 'failed', message: error.message } });
      }
    };
    load();
    return () => {
      active = false;
      useStore.setState({ messageTagLookup: { kind: 'ready', tags: {} } });
    };
  }, [key, showMessageTags, messageTagsPreferencesLoaded, messagesRefreshToken, user?.id]);
  return null;
}
