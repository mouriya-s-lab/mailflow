import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';

const SOURCES = [
  ['rdap', 'RDAP'], ['spamhaus_dbl', 'Spamhaus DBL'], ['urlhaus', 'URLhaus'], ['safe_browsing', 'Google Safe Browsing'],
];
const sourceName = source => SOURCES.find(([id]) => id === source)[1];

function chipText(chip, t) {
  switch (chip.kind) {
    case 'listed': return t('messageTags.listed', { source: sourceName(chip.source) });
    case 'new_domain': return t('messageTags.newDomain', { domain: chip.domain, ageDays: chip.ageDays });
    case 'unknown': return t('messageTags.unknown', { source: sourceName(chip.source) });
    default: throw new Error(`Unknown tag chip: ${chip.kind}`);
  }
}

function stateText(state, t) {
  switch (state.kind) {
    case 'inactive': return t('messageTags.inactive');
    case 'unconfigured': return t('messageTags.unconfigured');
    case 'unchecked': return t('messageTags.unchecked');
    case 'complete': return t('messageTags.complete', {
      checkedAt: new Date(state.checkedAt).toLocaleString(), subjects: state.subjects, listed: state.listed, unknown: state.unknown,
    });
    case 'unavailable':
      switch (state.reason) {
        case 'plugin_failed': return t('messageTags.pluginFailed');
        case 'deadline': return t('messageTags.deadline');
        case 'body_unavailable': return t('messageTags.bodyUnavailable');
        default: throw new Error(`Unknown tag failure: ${state.reason}`);
      }
    default: throw new Error(`Unknown tag state: ${state.kind}`);
  }
}

export default function MessageTags({ messageId, detail = false, style }) {
  const { t } = useTranslation();
  const enabled = useStore(s => s.showMessageTags && s.messageTagsPreferencesLoaded && Boolean(s.user?.id));
  const userId = useStore(s => s.user?.id);
  const lookup = useStore(s => s.messageTagLookup);
  useEffect(() => {
    if (!enabled || !messageId) return;
    useStore.getState().retainMessageTagId(messageId);
    return () => useStore.getState().releaseMessageTagId(messageId);
  }, [enabled, messageId, userId]);
  if (!enabled) return null;
  const summary = lookup.kind === 'ready' ? lookup.tags[messageId] : null;
  if (!detail && !summary?.notable.length) return null;
  if (lookup.kind === 'ready' && !summary) return null;
  return (
    <div data-message-tags={messageId} style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4, minWidth: 0, ...style }}>
      {summary?.notable.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {summary.notable.map((chip, index) => (
            <span key={index} data-tag-kind={chip.kind} style={{
              fontSize: 11, lineHeight: 1.5, fontWeight: 500, borderRadius: 4, padding: '1px 6px',
              color: chip.kind === 'listed' ? 'var(--red)' : 'var(--amber)',
              background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', overflowWrap: 'anywhere',
            }}>{chipText(chip, t)}</span>
          ))}
        </div>
      )}
      {detail && (summary ? (
        <dl aria-label={t('messageTags.sources')} style={{ margin: 0, fontSize: 11, fontWeight: 400, color: 'var(--text-secondary)' }}>
          {SOURCES.map(([source, name]) => (
            <div key={source} data-tag-source={source} style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', lineHeight: 1.6 }}>
              <dt style={{ fontWeight: 500 }}>{name}</dt>
              <dd style={{ margin: 0 }}>{stateText(summary.sources[source], t)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div role={lookup.kind === 'failed' ? 'alert' : 'status'} style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-secondary)' }}>
          {lookup.kind === 'failed' ? t('messageTags.loadFailed', { message: lookup.message }) : t('common.loading')}
        </div>
      ))}
    </div>
  );
}
