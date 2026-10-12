// One DNS A query over UDP to the configured recursive resolver, returning what Node's resolver
// API does not: the TTL a negative answer may be cached for (RFC 2308: the lesser of the SOA
// record's TTL and its MINIMUM field, from the authority section). The Spamhaus DBL adapter caches
// "not listed" for exactly that long.

import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { randomInt } from 'node:crypto';

const TYPE_A = 1;
const TYPE_SOA = 6;
const CLASS_IN = 1;

// "1.2.3.4", "1.2.3.4:53", "::1", "[::1]:53" as dns.getServers() reports them.
function parseServer(server) {
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(server);
  if (bracketed) return { address: bracketed[1], port: Number(bracketed[2] ?? 53) };
  if (net.isIPv6(server)) return { address: server, port: 53 };
  const [address, port] = server.split(':');
  return { address, port: Number(port ?? 53) };
}

export function encodeQuery(id, name) {
  const labels = name.split('.').filter(Boolean).map(label => {
    const bytes = Buffer.from(label, 'ascii');
    if (bytes.length > 63) throw new RangeError('DNS label longer than 63 bytes');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // standard query, recursion desired
  header.writeUInt16BE(1, 4); // one question
  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE_A, 0);
  question.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), question]);
}

// Offset just past the (possibly compressed) name starting at `offset`.
function skipName(message, offset) {
  for (;;) {
    const length = message[offset];
    if (length === undefined) throw new RangeError('truncated name');
    if ((length & 0xc0) === 0xc0) return offset + 2;
    if (length === 0) return offset + 1;
    offset += length + 1;
  }
}

// { rcode, addresses: [{ address, ttl }], negativeTtl } of the response to `query`; null for a
// datagram that is not that response (another id, not a response, another question). Throws on a
// truncated or malformed response.
export function parseResponse(message, query) {
  if (message.length < 12 || message.readUInt16BE(0) !== query.readUInt16BE(0)) return null;
  const flags = message.readUInt16BE(2);
  if (!(flags & 0x8000)) return null;
  if (flags & 0x0200) throw new RangeError('truncated response');
  const question = query.subarray(12);
  const echoed = message.subarray(12, 12 + question.length);
  // Resolvers may randomize the case of the name they forward, so compare names case-insensitively.
  if (message.readUInt16BE(4) !== 1 || echoed.toString('latin1').toLowerCase() !== question.toString('latin1').toLowerCase()) {
    return null;
  }
  const sections = [{ name: 'answer', count: message.readUInt16BE(6) }, { name: 'authority', count: message.readUInt16BE(8) }];
  let offset = 12 + question.length;
  const addresses = [];
  let negativeTtl = null;
  for (const section of sections) {
    for (let i = 0; i < section.count; i++) {
      offset = skipName(message, offset);
      if (offset + 10 > message.length) throw new RangeError('truncated record');
      const type = message.readUInt16BE(offset);
      const recordClass = message.readUInt16BE(offset + 2);
      const ttl = message.readUInt32BE(offset + 4);
      const length = message.readUInt16BE(offset + 8);
      const data = offset + 10;
      if (data + length > message.length) throw new RangeError('truncated record');
      if (section.name === 'answer' && type === TYPE_A && recordClass === CLASS_IN && length === 4) {
        addresses.push({ address: [...message.subarray(data, data + 4)].join('.'), ttl });
      }
      // SOA rdata ends with the MINIMUM field.
      if (section.name === 'authority' && type === TYPE_SOA && length >= 22) {
        negativeTtl = Math.min(ttl, message.readUInt32BE(data + length - 4));
      }
      offset = data + length;
    }
  }
  return { rcode: flags & 0x0f, addresses, negativeTtl };
}

// Resolves to { kind: 'answer', rcode, addresses, negativeTtl }, { kind: 'timeout' } or
// { kind: 'error' }; never throws. The servers are tried in order when one cannot be reached.
export function queryA(name, { servers = dns.getServers(), timeoutMs }) {
  return new Promise(resolve => {
    const id = randomInt(0, 0x10000);
    let query;
    try {
      query = encodeQuery(id, name);
    } catch {
      resolve({ kind: 'error' });
      return;
    }
    const targets = servers.map(parseServer);
    let socket = null;
    let current = -1;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    // A connected socket hears only its server and reports an unreachable one as an error.
    const attempt = index => {
      if (settled || index !== current + 1) return;
      current = index;
      socket?.close();
      socket = null;
      if (index >= targets.length) {
        finish({ kind: 'error' });
        return;
      }
      const { address, port } = targets[index];
      const own = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4');
      socket = own;
      own.on('error', () => { if (socket === own) attempt(index + 1); });
      own.on('message', message => {
        let parsed;
        try {
          parsed = parseResponse(message, query);
        } catch {
          finish({ kind: 'error' });
          return;
        }
        if (parsed) finish({ kind: 'answer', ...parsed });
      });
      own.connect(port, address, err => {
        if (err) attempt(index + 1);
        else own.send(query, sendErr => { if (sendErr && socket === own) attempt(index + 1); });
      });
    };
    attempt(0);
  });
}
