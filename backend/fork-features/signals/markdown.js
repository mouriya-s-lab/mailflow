// OMP's local HTML reader uses html_to_markdown_rs with aggressive preprocessing and Tier2.
import { convert, WasmConversionOptions, WasmPreprocessingOptions, WasmPreprocessingPreset, WasmTierStrategy } from '@xberg-io/html-to-markdown-wasm';
import { query } from '../../src/services/db.js';

// The official WASM binding uses the same Rust core without a platform-specific addon loader.
const options = WasmConversionOptions.default();
const preprocessing = new WasmPreprocessingOptions(true, WasmPreprocessingPreset.Aggressive, true, true);
options.preprocessing = preprocessing;
preprocessing.free();
options.tierStrategy = WasmTierStrategy.Tier2;
// Match OMP's native defaults; the WASM build otherwise imposes its own 2 MiB input cap.
options.maxInputSize = null;

export function messageBodyMarkdown({ bodyText, bodyHtml }) {
  if (typeof bodyHtml !== 'string' || !bodyHtml.trim()) return typeof bodyText === 'string' ? bodyText : '';
  // convert takes ownership of its options; retain the immutable template for later messages.
  const result = convert(bodyHtml, options.copyForTransfer());
  const warnings = result.warnings;
  try {
    if (warnings.some(warning => warning.kind === 'depth_limit_exceeded')) {
      throw new Error('Markdown conversion exceeded the HTML depth limit');
    }
    return result.content ?? '';
  } finally {
    for (const warning of warnings) warning.free();
    result.free();
  }
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
