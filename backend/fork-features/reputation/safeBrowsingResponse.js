// Only the hashes.search response messages from Google's v5 schema:
// https://github.com/googleapis/googleapis/blob/master/google/security/safebrowsing/v5/safebrowsing.proto
// HTTP responses are protobuf (https://developers.google.com/safe-browsing/reference).
// Decode those fields into the same shape as the documented JSON representation.

const THREATS = ['THREAT_TYPE_UNSPECIFIED', 'MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];
const invalid = detail => ({ kind: 'invalid', detail });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class WireReader {
  constructor(body, message) {
    this.body = body;
    this.message = message;
    this.offset = 0;
  }

  fail(detail) {
    throw new RangeError(`protobuf ${this.message}: ${detail}`);
  }

  varint() {
    let value = 0n;
    for (let byteIndex = 0; byteIndex < 10; byteIndex++) {
      if (this.offset === this.body.length) this.fail('truncated varint');
      const byte = this.body[this.offset++];
      if (byteIndex === 9 && byte > 1) this.fail('varint exceeds uint64');
      value |= BigInt(byte & 127) << BigInt(byteIndex * 7);
      if (byte < 128) return value;
    }
    this.fail('varint exceeds uint64');
  }

  bytes(length) {
    if (length > BigInt(this.body.length - this.offset)) this.fail('truncated length-delimited or fixed-width field');
    const end = this.offset + Number(length);
    const value = this.body.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  *fields() {
    while (this.offset < this.body.length) {
      const tag = this.varint();
      if (tag < 8n || tag > 0xffffffffn) this.fail('invalid field tag');
      const number = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      let value;
      switch (wire) {
        case 0: value = this.varint(); break;
        case 1: value = this.bytes(8n); break;
        case 2: value = this.bytes(this.varint()); break;
        case 5: value = this.bytes(4n); break;
        default: this.fail('unsupported wire type');
      }
      yield { number, wire, value };
    }
  }

  expect(field, wire) {
    if (field.wire !== wire) this.fail(`wrong wire type for field ${field.number}`);
    return field.value;
  }
}

function fullHashDetail(body) {
  const reader = new WireReader(body, 'FullHashDetail');
  const detail = { threatType: THREATS[0], attributes: [] };
  for (const field of reader.fields()) {
    if (field.number === 1) {
      const value = reader.expect(field, 0);
      detail.threatType = THREATS[Number(value)] ?? THREATS[0];
    } else if (field.number === 2) {
      if (field.wire === 0) detail.attributes.push(field.value);
      else {
        const packed = new WireReader(reader.expect(field, 2), 'FullHashDetail.attributes');
        while (packed.offset < packed.body.length) detail.attributes.push(packed.varint());
      }
    }
  }
  return detail;
}

function fullHash(body) {
  const reader = new WireReader(body, 'FullHash');
  let hash = Buffer.alloc(0);
  const fullHashDetails = [];
  for (const field of reader.fields()) {
    if (field.number === 1) hash = reader.expect(field, 2);
    else if (field.number === 2) fullHashDetails.push(fullHashDetail(reader.expect(field, 2)));
  }
  if (hash.length !== 32) reader.fail('invalid fullHash length (expected 32 bytes)');
  return { fullHash: hash.toString('base64'), fullHashDetails };
}

function durationFields(body, duration) {
  const reader = new WireReader(body, 'Duration');
  for (const field of reader.fields()) {
    if (field.number === 1) duration.seconds = BigInt.asIntN(64, reader.expect(field, 0));
    else if (field.number === 2) duration.nanos = reader.expect(field, 0);
  }
}

function protobufResponse(body) {
  const reader = new WireReader(body, 'SearchHashesResponse');
  const fullHashes = [];
  let duration = null;
  for (const field of reader.fields()) {
    if (field.number === 1) fullHashes.push(fullHash(reader.expect(field, 2)));
    else if (field.number === 2) {
      duration ??= { seconds: 0n, nanos: 0n };
      durationFields(reader.expect(field, 2), duration);
    }
  }
  if (!duration) reader.fail('missing cacheDuration');
  if (duration.seconds < 0n || duration.seconds > 315576000000n || duration.nanos < 0n || duration.nanos > 999999999n) {
    reader.fail('invalid cacheDuration seconds or nanos');
  }
  return { kind: 'parsed', fullHashes, ttlMs: Number(duration.seconds) * 1000 + Number(duration.nanos / 1000000n) };
}

function jsonResponse(body) {
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return invalid('JSON response: malformed JSON'); }
  const match = isRecord(parsed) && typeof parsed.cacheDuration === 'string'
    ? /^(\d+)(?:\.(\d{1,9}))?s$/.exec(parsed.cacheDuration) : null;
  if (!match) return invalid('JSON response: invalid cacheDuration');
  const ttlMs = Number(match[1]) * 1000 + Math.floor(Number(`0.${match[2] ?? '0'}`) * 1000);
  if (!Number.isSafeInteger(ttlMs) || Number(match[1]) > 315576000000) return invalid('JSON response: invalid cacheDuration');
  const fullHashes = parsed.fullHashes ?? [];
  if (!Array.isArray(fullHashes) || !fullHashes.every(h => isRecord(h) && typeof h.fullHash === 'string')) {
    return invalid('JSON response: invalid fullHashes');
  }
  return { kind: 'parsed', fullHashes, ttlMs };
}

export function parseSafeBrowsingResponse(body, contentType) {
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json') return jsonResponse(body);
  if (mediaType !== 'application/x-protobuf') return invalid('unsupported response Content-Type (expected application/x-protobuf or application/json)');
  try { return protobufResponse(body); } catch (error) {
    if (error instanceof RangeError) return invalid(error.message);
    throw error;
  }
}
