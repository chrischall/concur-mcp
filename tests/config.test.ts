import { describe, expect, it } from 'vitest';
import { ConcurConfigError, DEFAULT_DC, DEFAULT_WS_PORT, configForDc, readConfig, readWsPort } from '../src/config.js';

describe('readConfig', () => {
  it('defaults to the us2 datacenter and derives every host from it', () => {
    const config = readConfig({});
    expect(DEFAULT_DC).toBe('us2');
    expect(config).toEqual({
      dc: 'us2',
      webOrigin: 'https://us2.concursolutions.com',
      apiOrigin: 'https://www-us2.api.concursolutions.com',
      spendGraphqlUrl: 'https://www-us2.api.concursolutions.com/spend-graphql/graphql',
      spendUploadUrl: 'https://www-us2.api.concursolutions.com/spend-graphql/upload',
      cdsGraphqlUrl: 'https://www-us2.api.concursolutions.com/cds/graphql',
      expectedIssuer: 'https://us2.api.concursolutions.com',
    });
  });

  it('honours CONCUR_DC, trimmed and lower-cased', () => {
    const config = readConfig({ CONCUR_DC: ' EU2 ' });
    expect(config.dc).toBe('eu2');
    expect(config.webOrigin).toBe('https://eu2.concursolutions.com');
    expect(config.spendGraphqlUrl).toBe('https://www-eu2.api.concursolutions.com/spend-graphql/graphql');
    expect(config.expectedIssuer).toBe('https://eu2.api.concursolutions.com');
  });

  it('treats an unexpanded host placeholder as unset', () => {
    expect(readConfig({ CONCUR_DC: '${user_config.concur_dc}' }).dc).toBe('us2');
  });

  it.each(['us2.evil.com', 'us-2', 'a/b', '2us', 'x'.repeat(12)])(
    'refuses a datacenter that is not a bare host label (%s)',
    (dc) => {
      expect(() => readConfig({ CONCUR_DC: dc })).toThrow(ConcurConfigError);
      expect(() => readConfig({ CONCUR_DC: dc })).toThrow(/CONCUR_DC/);
    },
  );

  it('configForDc is the pure host derivation', () => {
    expect(configForDc('us').cdsGraphqlUrl).toBe('https://www-us.api.concursolutions.com/cds/graphql');
  });
});

describe('readWsPort', () => {
  it('defaults to the fleet concentrator port', () => {
    expect(DEFAULT_WS_PORT).toBe(37_149);
    expect(readWsPort({})).toBe(37_149);
  });

  it('honours CONCUR_WS_PORT', () => {
    expect(readWsPort({ CONCUR_WS_PORT: '40001' })).toBe(40_001);
  });
});
