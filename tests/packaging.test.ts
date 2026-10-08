import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const readText = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// These only fail once a tag exists (npm provenance validates repository.url,
// the registry validates the scoped name), so assert them up front.
describe('packaging', () => {
  const pkg = read('package.json');

  it('publishes under the @chrischall scope, publicly, with a provenance-checkable repository.url', () => {
    expect(pkg.name).toBe('@chrischall/concur-mcp');
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.repository?.url).toBe('git+https://github.com/chrischall/concur-mcp.git');
  });

  it('ships dist, skills, the plugin, manifests and mint.yaml in the published tarball', () => {
    for (const f of ['dist', 'skills', '.claude-plugin', '.mcp.json', 'manifest.json', 'server.json', 'mint.yaml']) {
      expect(pkg.files).toContain(f);
    }
  });

  it('exposes a single unscoped bin pointing at the tsc entry', () => {
    expect(pkg.bin).toEqual({ 'concur-mcp': 'dist/index.js' });
  });

  it('the Claude plugin launches the published package, not the gitignored dist/', () => {
    const server = read('.mcp.json').mcpServers.concur;
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', pkg.name]);
    expect(JSON.stringify(server)).not.toMatch(/dist\//);
  });

  it('server.json description is within the 100-char registry limit', () => {
    expect(read('server.json').description.length).toBeLessThanOrEqual(100);
  });

  it('server.json and release-please name the scoped package', () => {
    expect(read('server.json').packages[0].identifier).toBe(pkg.name);
    expect(read('release-please-config.json').packages['.']['package-name']).toBe(pkg.name);
  });

  it('a brand-new package starts at 0.1.0, not 1.0.0, and stays 0.x on breaking changes', () => {
    // Config only — never pin the manifest version here: release PRs bump it.
    const cfg = read('release-please-config.json').packages['.'];
    expect(cfg['initial-version']).toBe('0.1.0');
    expect(cfg['bump-minor-pre-major']).toBe(true);
  });

  it('release-please bumps every version-bearing file', () => {
    const extra = read('release-please-config.json').packages['.']['extra-files'] as (
      | string
      | { path: string; jsonpath: string }
    )[];
    const keys = extra.map((e) => (typeof e === 'string' ? e : `${e.path}#${e.jsonpath}`));
    expect(keys).toEqual(
      expect.arrayContaining([
        'manifest.json#$.version',
        'server.json#$.version',
        'server.json#$.packages[*].version',
        '.claude-plugin/plugin.json#$.version',
        '.claude-plugin/marketplace.json#$.plugins[*].version',
        '.claude-plugin/marketplace.json#$.metadata.version',
        'src/version.ts',
      ]),
    );
  });

  it('all version-bearing manifests agree with package.json', () => {
    const v = pkg.version;
    expect(VERSION).toBe(v);
    expect(read('manifest.json').version).toBe(v);
    expect(read('server.json').version).toBe(v);
    expect(read('server.json').packages[0].version).toBe(v);
    expect(read('.claude-plugin/plugin.json').version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').metadata.version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').plugins[0].version).toBe(v);
    expect(read('.release-please-manifest.json')['.']).toBe(v);
  });

  it('mint.yaml keeps the bridge identity across restarts and declares the env it reads', () => {
    const mint = readText('mint.yaml');
    expect(mint).toMatch(/slug: concur\n/);
    expect(mint).toMatch(/dataDir:\s*true/);
    for (const name of ['CONCUR_DC', 'CONCUR_WS_PORT', 'MCP_CONFIRM_MODE', 'MCP_CONFIRM_ELICITATION']) {
      expect(mint, name).toMatch(new RegExp(`- name: ${name}\\n`));
    }
    // Egress is tenant-derived (www-<dc>.api…), so no fixed allow-list is declared.
    expect(mint).not.toMatch(/^egress:/m);
  });

  it('the vitest pair is grouped first in dependabot so a major never splits it', () => {
    const dependabot = readText('.github/dependabot.yml');
    const groups = dependabot.slice(dependabot.indexOf('groups:'));
    expect(groups.indexOf('vitest:')).toBeGreaterThan(-1);
    expect(groups.indexOf('vitest:')).toBeLessThan(groups.indexOf('dev-dependencies:'));
    expect(groups).toMatch(/- "@vitest\/coverage-v8"/);
  });
});
