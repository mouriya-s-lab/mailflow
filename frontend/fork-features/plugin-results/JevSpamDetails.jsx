import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getStoredResult } from './api.js';
import StoredObservation from './StoredObservation.jsx';

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isDetail(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && value.plugin
      && typeof value.plugin === 'object'
      && value.message
      && typeof value.message === 'object'
      && value.message.observation
      && typeof value.message.observation === 'object'
  );
}

const shellStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0,
  overflowWrap: 'anywhere',
  marginTop: 6,
  padding: '8px 10px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 6,
  background: 'var(--bg-tertiary)',
};

export default function JevSpamDetails({ messageId }) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(() => ({ kind: 'loading', messageId }));

  useEffect(() => {
    let active = true;
    if (!messageId) return () => { active = false; };

    setState({ kind: 'loading', messageId });
    (async () => {
      try {
        const detail = await getStoredResult('jev-classify', messageId);
        if (!isDetail(detail)) throw new Error('Stored result response was invalid.');
        if (active) setState({ kind: 'loaded', messageId, detail });
      } catch (error) {
        if (active) setState({ kind: 'failed', messageId, message: errorText(error) });
      }
    })();

    return () => { active = false; };
  }, [messageId, attempt]);

  if (!messageId) return null;

  // A message switch can render once before the effect cleanup runs. Never let the
  // previous message's loaded/error state appear in that frame.
  const currentState = state.messageId === messageId ? state : { kind: 'loading', messageId };
  if (currentState.kind === 'loading') {
    return (
      <div role="status" style={shellStyle} data-jev-result-state="loading">
        {t('pluginResults.loading')}
      </div>
    );
  }

  if (currentState.kind === 'failed') {
    return (
      <div role="alert" style={shellStyle} data-jev-result-state="failed">
        <div>{t('pluginResults.loadFailed', { error: currentState.message })}</div>
        <button
          type="button"
          onClick={() => {
            setState({ kind: 'loading', messageId });
            setAttempt(value => value + 1);
          }}
          style={{
            alignSelf: 'flex-start',
            padding: '4px 9px',
            minHeight: 44,
            maxWidth: '100%',
            border: '1px solid var(--border)',
            borderRadius: 4,
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 12,
          }}
        >
          {t('pluginResults.retry')}
        </button>
      </div>
    );
  }

  const { detail } = currentState;
  const plugin = detail.plugin;
  const observation = detail.message.observation;
  // An inactive plugin with no stored observation has no result to show. The
  // request still happened: a previously saved result must remain visible after
  // the plugin is disabled or unconfigured.
  if (observation.kind === 'none' && !plugin.activated) return null;

  return (
    <section style={shellStyle} data-jev-result-state="loaded" data-message-id={messageId}>
      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{t('pluginResults.jevTitle')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', color: 'var(--text-tertiary)' }}>
        <span>{t(plugin.activated ? 'pluginResults.active' : 'pluginResults.inactive')}</span>
        <span>{t(plugin.configuration === 'enabled' ? 'pluginResults.configured' : 'pluginResults.unconfigured')}</span>
      </div>
      <div style={{ color: 'var(--text-tertiary)' }}>
        {t('pluginResults.observedAt', { time: formatDate(detail.observedAt) })}
      </div>
      <div style={{ color: 'var(--text-tertiary)' }}>{t('pluginResults.storedOnly')}</div>
      <StoredObservation observation={observation} />
    </section>
  );
}
