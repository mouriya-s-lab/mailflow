import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { spamApi } from '../utils/spamApi.js';
import { useMobile } from '../hooks/useMobile.js';

// "Why was this marked as spam?" modal (v0.2) — shows the rule and ML
// contributions that produced the verdict for a message. Opened from the
// auto-spam badge in MessageList / MessagePane.

export default function SpamExplainModal({ messageId, onClose }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    spamApi.explain(messageId)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [messageId]);

  const overlayStyle = {
    position: 'fixed', inset: 0, zIndex: 9000,
    background: 'rgba(0,0,0,.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: isMobile ? 12 : 24, boxSizing: 'border-box',
  };
  const cardStyle = {
    background: 'var(--bg-primary, #1f1f28)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    maxWidth: 520, width: '100%', minWidth: 0, boxSizing: 'border-box',
    maxHeight: isMobile ? 'calc(100dvh - 24px)' : '80vh', overflowY: 'auto',
    padding: isMobile ? 12 : 20, overflowWrap: 'anywhere',
    display: 'flex', flexDirection: 'column', gap: 12,
    color: 'var(--text-primary)',
  };
  const sectionTitle = { fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-secondary)', margin: '8px 0 4px' };
  const summaryStyle = { display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 8 : 16, flexWrap: 'wrap', minWidth: 0, fontSize: 13 };
  const evidenceRowStyle = { fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: '4px 12px', flexWrap: 'wrap', minWidth: 0 };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, position: 'sticky', top: 0, zIndex: 1, flexShrink: 0, paddingBottom: 8, background: 'var(--bg-primary, #1f1f28)' }}>
          <h3 style={{ margin: 0, minWidth: 0, fontSize: 16 }}>{t('spam.explainTitle')}</h3>
          <button type="button" onClick={onClose} aria-label={t('common.close')}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18, minWidth: 44, minHeight: 44, flexShrink: 0 }}>
            ✕
          </button>
        </div>

        {error && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 13 }}>{error}</div>}

        {data && !error && (
          <>
            <div style={summaryStyle}>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>{t('spam.explainVerdict')}: </span>
                <strong style={{ color: data.verdict === 'spam' ? 'var(--danger, #dc2626)' : 'var(--text-primary)' }}>
                  {t(`spam.verdict.${data.verdict || 'ham'}`)}
                </strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>{t('spam.explainMethod')}: </span>
                <strong>{t(`spam.method.${data.method || 'rules'}`)}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>{t('spam.explainConfidence')}: </span>
                <strong>
                  {data.mlProbability != null
                    ? `${Math.round(data.mlProbability * 100)}%`
                    : `${Math.round((data.confidence ?? 0) * 100)}%`}
                </strong>
              </div>
            </div>

            <div>
              <div style={sectionTitle}>{t('spam.explainPartitionTitle')}</div>
              {data.partition ? (
                <div style={summaryStyle}>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('spam.statLanguage')}: </span>
                    <strong>{data.partition.language}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('spam.statRecords')}: </span>
                    <strong>{data.partition.trainingRecords}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('spam.statMaturity')}: </span>
                    <strong>{t(`spam.maturity.${data.partition.maturity}`)}</strong>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('spam.explainLegacyPartition')}</div>
              )}
            </div>

            <div>
              <div style={sectionTitle}>{t('spam.rulesFiredTitle')}</div>
              {data.rulesFired?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {data.rulesFired.map((r, i) => (
                    <div key={i} style={evidenceRowStyle}>
                      <span style={{ flex: '1 1 0', minWidth: 0, overflowWrap: 'anywhere' }}>✓ {r.name}</span>
                      <span style={{ flexShrink: 0, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                        {r.weight > 0 ? '+' : ''}{r.weight.toFixed(1)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('spam.noRulesFired')}</div>
              )}
            </div>

            <div>
              <div style={sectionTitle}>{t('spam.mlTokensTitle')}</div>
              {data.mlTopTokens?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {data.mlTopTokens.map((tok, i) => (
                    <div key={i} style={evidenceRowStyle}>
                      <span style={{ flex: '1 1 0', minWidth: 0, overflowWrap: 'anywhere' }}>&ldquo;{tok.token}&rdquo;</span>
                      <span style={{ flexShrink: 0, color: tok.contribution > 0 ? 'var(--danger, #dc2626)' : 'var(--text-secondary)' }}>
                        {tok.contribution > 0 ? '+' : ''}{tok.contribution.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('spam.noMlTokens')}</div>
              )}
            </div>
          </>
        )}

        {!data && !error && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('common.loading')}</div>
        )}
      </div>
    </div>
  );
}