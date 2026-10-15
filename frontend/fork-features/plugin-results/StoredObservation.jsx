import { useTranslation } from 'react-i18next';

const SOURCE_NAMES = Object.freeze({
  spamhaus_dbl: 'Spamhaus DBL',
  urlhaus: 'URLhaus',
  safe_browsing: 'Google Safe Browsing',
});

const frameStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0,
  fontSize: 12,
  color: 'var(--text-secondary)',
};

const rowsStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)',
  gap: '3px 10px',
  margin: 0,
};

function impossible(value, label) {
  throw new Error(`Unknown stored result ${label}: ${String(value)}`);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function Revision({ revision, t }) {
  return (
    <div data-result-revision={revision == null ? 'null' : String(revision)} style={{ color: 'var(--text-tertiary)' }}>
      {revision == null
        ? t('pluginResults.noRevision')
        : t('pluginResults.revision', { revision })}
    </div>
  );
}

function InfoRows({ rows }) {
  return (
    <dl style={rowsStyle}>
      {rows.map(({ label, value }, index) => (
        <div key={`${label}:${index}`} style={{ display: 'contents' }}>
          <dt style={{ fontWeight: 600, color: 'var(--text-tertiary)' }}>{label}</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Frame({ observation, t, children }) {
  return (
    <div data-stored-observation={observation.kind} style={frameStyle}>
      <Revision revision={observation.revision} t={t} />
      {children}
    </div>
  );
}

function outcomeText(outcome, t) {
  switch (outcome) {
    case 'spam': return t('pluginResults.facets.spam');
    case 'ham': return t('pluginResults.facets.ham');
    case 'uncertain': return t('pluginResults.facets.uncertain');
    default: return impossible(outcome, 'Jev outcome');
  }
}

function decisionText(decision, t) {
  switch (decision.kind) {
    case 'pending': return t('pluginResults.facets.pending');
    case 'retry': return t('pluginResults.facets.retry');
    case 'done': return outcomeText(decision.outcome, t);
    case 'skipped': return t('pluginResults.facets.disabled');
    case 'terminal_failed': return t('pluginResults.facets.failed');
    default: return impossible(decision.kind, 'Jev decision');
  }
}

function trainingText(training, t) {
  switch (training.kind) {
    case 'blocked':
    case 'below_threshold':
    case 'no_message_id':
    case 'pending':
    case 'recorded':
    case 'duplicate':
    case 'retry':
    case 'terminal_failed':
    case 'skipped':
    case 'unrecognized':
      return t(`pluginResults.trainingStates.${training.kind}`);
    default: return impossible(training.kind, 'Jev training');
  }
}

function JevObservation({ observation, t }) {
  const decisionRows = [{ label: t('pluginResults.result'), value: decisionText(observation.decision, t) }];
  if (observation.decision.kind === 'done') {
    decisionRows.push(
      { label: t('pluginResults.probability'), value: String(observation.decision.probability) },
      { label: t('pluginResults.model'), value: observation.decision.model },
      { label: t('pluginResults.decidedAt'), value: formatDate(observation.decision.decidedAt) },
    );
  } else if (observation.decision.kind === 'retry' || observation.decision.kind === 'terminal_failed') {
    decisionRows.push({ label: t('pluginResults.reason'), value: observation.decision.errorKind });
  } else if (observation.decision.kind === 'skipped') {
    decisionRows.push({ label: t('pluginResults.reason'), value: observation.decision.reason });
  }

  const trainingRows = [{ label: t('pluginResults.result'), value: trainingText(observation.training, t) }];
  if (observation.training.kind === 'skipped') {
    trainingRows.push({ label: t('pluginResults.reason'), value: observation.training.reason });
  }

  return (
    <Frame observation={observation} t={t}>
      <section aria-label={t('pluginResults.jevTitle')}>
        <InfoRows rows={decisionRows} />
      </section>
      <section>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>{t('pluginResults.training')}</div>
        <InfoRows rows={trainingRows} />
        <div style={{ marginTop: 4, color: 'var(--text-tertiary)' }}>{t('pluginResults.trainingHint')}</div>
      </section>
    </Frame>
  );
}

function registrationRows(registration, t) {
  switch (registration.kind) {
    case 'known':
      return [
        { label: t('pluginResults.result'), value: t('pluginResults.verdicts.known') },
        { label: t('pluginResults.registeredAt'), value: formatDate(registration.registeredAt) },
      ];
    case 'not_found':
      return [{ label: t('pluginResults.result'), value: t('pluginResults.verdicts.not_found') }];
    case 'unknown':
      return [
        { label: t('pluginResults.result'), value: t('pluginResults.verdicts.unknown') },
        { label: t('pluginResults.reason'), value: registration.reason },
      ];
    default:
      return impossible(registration.kind, 'RDAP registration');
  }
}

function RdapObservation({ observation, t }) {
  return (
    <Frame observation={observation} t={t}>
      <div>{t('pluginResults.checkedAt', { time: formatDate(observation.checkedAt) })}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {observation.subjects.map((subject, index) => (
          <div key={`${subject.domain}:${index}`} style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 5 }}>
            <InfoRows rows={[
              { label: t('pluginResults.domain'), value: subject.domain },
              ...registrationRows(subject.registration, t),
            ]} />
          </div>
        ))}
      </div>
    </Frame>
  );
}

function listingSourceText(source) {
  switch (source) {
    case 'spamhaus_dbl':
    case 'urlhaus':
    case 'safe_browsing':
      return SOURCE_NAMES[source];
    default:
      return impossible(source, 'listing source');
  }
}

function listingRows(verdict, t) {
  switch (verdict.kind) {
    case 'listed':
      return [
        { label: t('pluginResults.result'), value: t('pluginResults.verdicts.listed') },
        { label: t('pluginResults.reason'), value: verdict.detail },
      ];
    case 'not_listed':
      return [{ label: t('pluginResults.result'), value: t('pluginResults.verdicts.not_listed') }];
    case 'unknown':
      return [
        { label: t('pluginResults.result'), value: t('pluginResults.verdicts.unknown') },
        { label: t('pluginResults.reason'), value: verdict.reason },
      ];
    default:
      return impossible(verdict.kind, 'listing verdict');
  }
}

function ListingSubject({ subject, t }) {
  const identityRows = subject.kind === 'domain'
    ? [{ label: t('pluginResults.domain'), value: subject.domain }]
    : [
      { label: t('pluginResults.host'), value: subject.host },
      { label: t('pluginResults.digest'), value: subject.urlDigest },
    ];
  return <InfoRows rows={[...identityRows, ...listingRows(subject.verdict, t)]} />;
}

function ListingObservation({ observation, t }) {
  return (
    <Frame observation={observation} t={t}>
      <div>
        {listingSourceText(observation.source)} · {t('pluginResults.checkedAt', { time: formatDate(observation.checkedAt) })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {observation.subjects.map((subject, index) => (
          <div key={`${subject.kind}:${subject.kind === 'domain' ? subject.domain : subject.urlDigest}:${index}`} style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 5 }}>
            <ListingSubject subject={subject} t={t} />
          </div>
        ))}
      </div>
    </Frame>
  );
}

export default function StoredObservation({ observation }) {
  const { t } = useTranslation();
  if (!observation || typeof observation !== 'object') throw new TypeError('stored observation is required');

  switch (observation.kind) {
    case 'none':
      return (
        <Frame observation={observation} t={t}>
          <div>{t('pluginResults.noResult')}</div>
        </Frame>
      );
    case 'unrecognized':
      return (
        <Frame observation={observation} t={t}>
          <div role="alert">{t('pluginResults.unrecognized')}</div>
        </Frame>
      );
    case 'jev_spam':
      return <JevObservation observation={observation} t={t} />;
    case 'rdap':
      return <RdapObservation observation={observation} t={t} />;
    case 'listing':
      return <ListingObservation observation={observation} t={t} />;
    default:
      return impossible(observation.kind, 'observation kind');
  }
}
