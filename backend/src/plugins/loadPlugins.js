import { pluginRegistry } from './registry.js';
import { gtdPlugin } from './gtd/index.js';
import { jevClassifyPlugin } from './jev-classify/index.js';
import { reputationTagPlugins } from './reputation-tags/index.js';

// Register the bundled (Tier-1, in-repo) plugins into the registry. Called once at boot,
// before routes are mounted. The order here is the order plugin routers mount in index.js.
export function loadBundledPlugins(registry = pluginRegistry) {
  registry.register(gtdPlugin);
  registry.register(jevClassifyPlugin);
  for (const plugin of reputationTagPlugins) registry.register(plugin);
  return registry;
}
