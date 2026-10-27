import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { fail } from '../../../../shared/unified-mail/index.mjs';

function publicAddress(value) {
  try {
    let ip = ipaddr.parse(value);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() === 'unicast';
  } catch { return false; }
}
// Resolve once, connect to the pinned IP, and retain the original TLS identity.
export async function resolvePublicEndpoint({ host, port }, resolver = lookup) {
  if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) fail('INVALID_INPUT');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) fail('INVALID_INPUT');
  return { host: addresses[0].address, port, servername: host };
}
