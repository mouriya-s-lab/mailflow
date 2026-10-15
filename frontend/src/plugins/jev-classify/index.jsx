// Jev classification plugin — frontend registrations (fork-only, mouriya-s-lab/mailflow#18), the
// twin of backend/src/plugins/jev-classify. Imported for its side effects by plugins/index.js.
import { registerSlot, registerPluginMeta } from '../registry.js';
import JevClassifySettings from './JevClassifySettings.jsx';

// The Plugins tab links an activated plugin to its settings: the block under Categories.
registerPluginMeta('jev-classify', {
  settingsLocation: { tab: 'categories', subtab: 'jev-classify', labelKey: 'admin.tabs.categories' },
  hasStoredResults: true,
});

// Categories, account settings and running state, after GTD's block. Rendered only while the user
// has the plugin activated. ctx: { initialSubTab } — 'jev-classify' scrolls the block into view.
registerSlot('settings-categories', {
  pluginId: 'jev-classify',
  order: 1,
  render: (ctx) => <JevClassifySettings initialSubTab={ctx.initialSubTab} />,
});
