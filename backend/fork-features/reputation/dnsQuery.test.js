import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeQuery, parseResponse, queryA } from './dnsQuery.js';

const NAME = 'listed.com.dqskey.dbl.dq.spamhaus.net';
const query = encodeQuery(0x1234, NAME);

// A response to `request`: header flags and counts, the echoed question, then raw records.
function response(request, { flags = 0x8180, answers = [], authority = [], question = request.subarray(12) } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(request.readUInt16BE(0), 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authority.length, 8);
  return Buffer.concat([header, question, ...answers, ...authority]);
}

function record(type, ttl, rdata) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xc00c, 0);
  head.writeUInt16BE(type, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt32BE(ttl, 6);
  head.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([head, rdata]);
}

const a = (address, ttl) => record(1, ttl, Buffer.from(address.split('.').map(Number)));
const soa = (ttl, minimum) => {
  const rdata = Buffer.alloc(22);
  [1, 3600, 600, 86400, minimum].forEach((value, i) => rdata.writeUInt32BE(value, 2 + i * 4));
  return record(6, ttl, rdata);
};

describe('parseResponse', () => {
  it('reads A records with their TTLs and the negative TTL of an SOA', () => {
    expect(parseResponse(response(query, { answers: [a('127.0.1.2', 300), a('127.0.1.4', 120)] }), query))
      .toEqual({ rcode: 0, addresses: [{ address: '127.0.1.2', ttl: 300 }, { address: '127.0.1.4', ttl: 120 }], negativeTtl: null });
    expect(parseResponse(response(query, { flags: 0x8183, authority: [soa(900, 60)] }), query))
      .toEqual({ rcode: 3, addresses: [], negativeTtl: 60 });
    expect(parseResponse(response(query, { flags: 0x8183, authority: [soa(30, 3600)] }), query))
      .toEqual({ rcode: 3, addresses: [], negativeTtl: 30 });
  });

  it('accepts the question echoed in another case', () => {
    const shouted = Buffer.from(query.subarray(12).toString('latin1').toUpperCase(), 'latin1');
    expect(parseResponse(response(query, { flags: 0x8183, question: shouted }), query)).toMatchObject({ rcode: 3 });
  });

  it('ignores a datagram that is not the response to this query', () => {
    expect(parseResponse(response(encodeQuery(0x4321, NAME), { answers: [a('127.0.1.2', 300)] }), query)).toBeNull();
    expect(parseResponse(response(query, { answers: [a('127.0.1.2', 300)] }), encodeQuery(0x1234, 'other.com.dqskey.dbl.dq.spamhaus.net'))).toBeNull();
    expect(parseResponse(response(query, { flags: 0x0100 }), query)).toBeNull();
  });

  it('throws on a truncated or malformed response', () => {
    expect(() => parseResponse(response(query, { flags: 0x8380 }), query)).toThrow('truncated response');
    const cut = response(query, { answers: [a('127.0.1.2', 300)] });
    expect(() => parseResponse(cut.subarray(0, cut.length - 2), query)).toThrow('truncated record');
    const lying = response(query, { answers: [a('127.0.1.2', 300)] });
    lying.writeUInt16BE(3, 6); // three answers announced, one present
    expect(() => parseResponse(lying, query)).toThrow(RangeError);
  });
});

describe('queryA', () => {
  const sockets = [];
  afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });

  async function server(reply) {
    const socket = dgram.createSocket('udp4');
    sockets.push(socket);
    socket.on('message', (message, from) => {
      for (const datagram of reply(message)) socket.send(datagram, from.port, from.address);
    });
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    return `127.0.0.1:${socket.address().port}`;
  }

  it('skips a stray datagram and settles on the real response', async () => {
    const address = await server(message => [
      response(encodeQuery(message.readUInt16BE(0) ^ 1, NAME), { answers: [a('127.0.1.6', 5)] }),
      response(message, { answers: [a('127.0.1.2', 300)] }),
    ]);
    expect(await queryA(NAME, { servers: [address], timeoutMs: 2000 }))
      .toEqual({ kind: 'answer', rcode: 0, addresses: [{ address: '127.0.1.2', ttl: 300 }], negativeTtl: null });
  });

  it('is an error for a malformed response and a timeout for none', async () => {
    const malformed = await server(message => [response(message, { flags: 0x8380 })]);
    expect(await queryA(NAME, { servers: [malformed], timeoutMs: 2000 })).toEqual({ kind: 'error' });
    const silent = await server(() => []);
    const started = Date.now();
    expect(await queryA(NAME, { servers: [silent], timeoutMs: 200 })).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
