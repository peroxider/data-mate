import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brand } from './brand.js';
import { patchConversationHero, patchHtmlTitle, patchManifestName, runtimePatches } from './runtime-patches.js';

const pluginDir = resolve('packaging/brand/dsh-brand-analyst');

describe('brand customization assets', () => {
  it('ships the brand plugin with all three slot registrations', () => {
    expect(existsSync(resolve(pluginDir, 'package.json'))).toBe(true);
    const client = readFileSync(resolve(pluginDir, 'lib/client.js'), 'utf8');
    for (const slot of ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark']) {
      expect(client).toContain(`"${slot}"`);
    }
    expect(client).toContain(brand.productName);
  });

  it('keeps the plugin package name aligned with the assemble registration', () => {
    const manifest = JSON.parse(readFileSync(resolve(pluginDir, 'package.json'), 'utf8')) as { name: string };
    expect(manifest.name).toBe('dsh-brand-analyst');
  });

  it('registers exactly the brand copy patches with their frozen target versions', () => {
    const brandPatches = runtimePatches.filter((p) =>
      p.transform === patchConversationHero || p.transform === patchHtmlTitle || p.transform === patchManifestName);
    expect(brandPatches).toHaveLength(3);
    for (const patch of brandPatches) expect(patch.version).toBe('0.2.0-rc.2');
  });
});
