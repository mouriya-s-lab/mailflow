import { registerSlot, registerPluginMeta } from '../registry.js';
import ReputationTagSettings from './ReputationTagSettings.jsx';

const plugins = [
  { pluginId: 'tag-rdap', name: 'RDAP' },
  { pluginId: 'tag-spamhaus', name: 'Spamhaus DBL' },
  { pluginId: 'tag-urlhaus', name: 'URLhaus' },
  { pluginId: 'tag-safebrowsing', name: 'Google Safe Browsing' },
];

plugins.forEach((plugin, index) => {
  registerPluginMeta(plugin.pluginId, {
    settingsLocation: { tab: 'categories', subtab: plugin.pluginId, labelKey: 'admin.tabs.categories' },
    hasStoredResults: true,
  });
  registerSlot('settings-categories', {
    pluginId: plugin.pluginId,
    order: 2 + index,
    render: ctx => <ReputationTagSettings {...plugin} initialSubTab={ctx.initialSubTab} />,
  });
});
