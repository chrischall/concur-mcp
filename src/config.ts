// Datacenter + host configuration. Pure and synchronous; a bad value throws
// ConcurConfigError, which ConcurClient stores and re-throws on the first tool
// call (deferred-config-error pattern) so the server still boots and lists its
// tools.

import { McpToolError, readEnvVar, readPortEnv } from '@chrischall/mcp-utils';

/** The datacenter the recon account lives on, and the fleet's default. */
export const DEFAULT_DC = 'us2';

/** The fleet-wide ContextMint Bridge concentrator port — never change it. */
export const DEFAULT_WS_PORT = 37_149;

export type EnvSource = Record<string, string | undefined>;

export interface ConcurConfig {
  /** Datacenter label, e.g. `us2` (from the signed-in tab's host). */
  dc: string;
  /** The web app's origin — where the browser session (and its `JWT` cookie) lives. */
  webOrigin: string;
  /** The API host every call goes to from Node. */
  apiOrigin: string;
  spendGraphqlUrl: string;
  spendUploadUrl: string;
  cdsGraphqlUrl: string;
  /** The `iss` a JWT for this datacenter carries. */
  expectedIssuer: string;
}

export class ConcurConfigError extends McpToolError {
  constructor(message: string, hint: string) {
    super(message, { hint });
    this.name = 'ConcurConfigError';
  }
}

// A bare host label only: letters then letters/digits (us, us2, eu2, emea…).
// Anything else could steer the Bearer token at a host that is not Concur's.
const DC_PATTERN = /^[a-z][a-z0-9]{0,9}$/;

/** Every host for one datacenter. No validation — see {@link readConfig}. */
export function configForDc(dc: string): ConcurConfig {
  const apiOrigin = `https://www-${dc}.api.concursolutions.com`;
  return {
    dc,
    webOrigin: `https://${dc}.concursolutions.com`,
    apiOrigin,
    spendGraphqlUrl: `${apiOrigin}/spend-graphql/graphql`,
    spendUploadUrl: `${apiOrigin}/spend-graphql/upload`,
    cdsGraphqlUrl: `${apiOrigin}/cds/graphql`,
    expectedIssuer: `https://${dc}.api.concursolutions.com`,
  };
}

/** Read `CONCUR_DC` (default `us2`) and derive the hosts. Throws {@link ConcurConfigError}. */
export function readConfig(env: EnvSource = process.env): ConcurConfig {
  const dc = (readEnvVar('CONCUR_DC', { env }) ?? DEFAULT_DC).toLowerCase();
  if (!DC_PATTERN.test(dc)) {
    throw new ConcurConfigError(
      `CONCUR_DC must be a bare SAP Concur datacenter label such as "us2" or "eu2" (got ${JSON.stringify(dc)}).`,
      'Set CONCUR_DC to the first label of your signed-in Concur tab\'s host — "us2" for us2.concursolutions.com — or unset it for the us2 default.',
    );
  }
  return configForDc(dc);
}

/** `CONCUR_WS_PORT`, defaulting to the shared concentrator port. */
export function readWsPort(env: EnvSource = process.env): number {
  return readPortEnv('CONCUR_WS_PORT', DEFAULT_WS_PORT, { env });
}
