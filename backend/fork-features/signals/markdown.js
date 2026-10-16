// OMP's local HTML reader uses html_to_markdown_rs with aggressive preprocessing and Tier2.
import { convert, PreprocessingPreset, TierStrategy, WarningKind } from '@xberg-io/html-to-markdown';
import { query } from '../../src/services/db.js';

export function messageBodyMarkdown({ bodyText, bodyHtml }) {
  if (typeof bodyHtml !== 'string' || !bodyHtml.trim()) return typeof bodyText === 'string' ? bodyText : '';
  const result = convert(bodyHtml, {
    preprocessing: {
      enabled: true,
      preset: PreprocessingPreset.Aggressive,
      removeNavigation: true,
      removeForms: true,
    },
    tierStrategy: TierStrategy.Tier2,
  });
  if (result.warnings.some(warning => warning.kind === WarningKind.DepthLimitExceeded)) {
    throw new Error('Markdown conversion exceeded the HTML depth limit');
  }
  return result.content ?? '';
}

// A missing id is not an empty document. Conversion failures belong to the individual message;
// database failures still reject the read. Never expose converter errors containing mail content.
export async function getAccountMessageBodyMarkdowns(accountId, messageIds) {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return new Map();
  const { rows } = await query(
    'SELECT id, body_text, body_html FROM messages WHERE account_id = $1 AND id = ANY($2::uuid[])',
    [accountId, ids],
  );
  return new Map(rows.map(row => {
    try {
      return [row.id, { kind: 'ready', document: messageBodyMarkdown({ bodyText: row.body_text, bodyHtml: row.body_html }) }];
    } catch {
      return [row.id, { kind: 'failed', reason: 'conversion_failed' }];
    }
  }));
}
