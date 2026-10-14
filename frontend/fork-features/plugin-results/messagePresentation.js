// Grouped rows combine a representative UUID with thread-level subject/sender metadata.
// An explicit physical presentation must keep the UUID point lookup already loaded in __dl_.
export function resolvePresentedMessage(messageId, presentation, list, threadMessages) {
  switch (presentation) {
    case 'single': {
      const exact = threadMessages[`__dl_${messageId}`]?.find(message => message.id === messageId);
      if (exact) return exact;
      break;
    }
    case 'auto': break;
    default: throw new TypeError(`Unknown message presentation: ${presentation}`);
  }
  const listed = list.find(message => message.id === messageId);
  if (listed) return listed;
  for (const thread of Object.values(threadMessages)) {
    const message = thread.find(message => message.id === messageId);
    if (message) return message;
  }
  return undefined;
}
