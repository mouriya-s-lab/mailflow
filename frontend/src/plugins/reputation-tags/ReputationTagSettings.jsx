import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMobile } from '../../hooks/useMobile.js';
import { reputationTagsApi } from './api.js';

export const STATUS_REFRESH_MS = 15_000;
const hintStyle = { fontSize: 12, color: 'var(--text-tertiary)', margin: '6px 0 10px', minWidth: 0, overflowWrap: 'anywhere' };
const buttonStyle = { padding: '6px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, maxWidth: '100%', overflowWrap: 'anywhere' };

function sourceText(t, source) {
  switch (source) {
    case 'enabled': return t('reputationTags.configured');
    case 'unconfigured': return t('reputationTags.unconfigured');
    case 'disabled': return t('reputationTags.disabled');
    default: throw new Error(`Unknown reputation source state: ${source}`);
  }
}

export default function ReputationTagSettings({ pluginId, name, initialSubTab }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const generation = useRef(0);
  const sectionRef = useRef(null);
  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await reputationTagsApi.getStatus(pluginId);
      if (mine === generation.current) { setStatus(next); setError(null); }
    } catch (err) {
      if (mine === generation.current) setError(err.message);
    }
  }, [pluginId]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => { clearInterval(timer); generation.current += 1; };
  }, [refresh]);
  const loaded = status !== null;
  useEffect(() => {
    if (loaded && initialSubTab === pluginId) sectionRef.current.scrollIntoView({ block: 'start' });
  }, [initialSubTab, pluginId, loaded]);

  return (
    <section ref={sectionRef} data-testid={`settings-${pluginId}`} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '24px 0 20px' }} />
      <h3 style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', margin: '0 0 6px' }}>{name}</h3>
      <p style={hintStyle}>{t('reputationTags.description')}</p>
      <button type="button" onClick={refresh} style={{ ...buttonStyle, minHeight: isMobile ? 44 : undefined }}>{t('reputationTags.refresh')}</button>
      {error && <p role="alert" style={{ ...hintStyle, color: 'var(--red)' }}>{t('reputationTags.refreshFailed', { error })}</p>}
      {status ? (
        <>
          <p data-testid="tag-source" style={{ fontSize: 13, color: status.source === 'enabled' ? 'var(--green)' : 'var(--text-secondary)' }}>{sourceText(t, status.source)}</p>
        </>
      ) : !error && <p style={hintStyle}>{t('common.loading')}</p>}
    </section>
  );
}
