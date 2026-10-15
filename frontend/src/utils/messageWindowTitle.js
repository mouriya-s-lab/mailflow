// Chrome and the minimized dock project the same window-owned exact read state.
export function messageWindowTitle(content, t) {
  switch (content.kind) {
    case 'loading': return t('common.loading');
    case 'ready': return content.message.subject?.trim() || t('common.noSubject');
    case 'error': return t('message.loadingError');
    default: throw new TypeError(`Unknown message window content: ${content.kind}`);
  }
}
