// NTLMv2 authentication messages (MS-NLMP) for the XMLA HTTP endpoint behind IIS Windows authentication.
// MD4 is implemented here: OpenSSL 3 (Node) no longer ships it by default.
const crypto = require('crypto');

function md4(input) {
  const msg = Buffer.from(input);
  const len = msg.length;
  const padded = Buffer.alloc(((len + 8) >> 6 << 6) + 64);
  msg.copy(padded);
  padded[len] = 0x80;
  padded.writeUInt32LE((len * 8) >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor((len * 8) / 0x100000000), padded.length - 4);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & y) | (x & z) | (y & z);
  const H = (x, y, z) => x ^ y ^ z;
  const X = new Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = padded.readUInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + F(b, c, d) + X[i]) | 0, 3);
      d = rotl((d + F(a, b, c) + X[i + 1]) | 0, 7);
      c = rotl((c + F(d, a, b) + X[i + 2]) | 0, 11);
      b = rotl((b + F(c, d, a) + X[i + 3]) | 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + G(b, c, d) + X[i] + 0x5a827999) | 0, 3);
      d = rotl((d + G(a, b, c) + X[i + 4] + 0x5a827999) | 0, 5);
      c = rotl((c + G(d, a, b) + X[i + 8] + 0x5a827999) | 0, 9);
      b = rotl((b + G(c, d, a) + X[i + 12] + 0x5a827999) | 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + H(b, c, d) + X[i] + 0x6ed9eba1) | 0, 3);
      d = rotl((d + H(a, b, c) + X[i + 8] + 0x6ed9eba1) | 0, 9);
      c = rotl((c + H(d, a, b) + X[i + 4] + 0x6ed9eba1) | 0, 11);
      b = rotl((b + H(c, d, a) + X[i + 12] + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((v, i) => out.writeInt32LE(v, i * 4));
  return out;
}

const UNICODE = 0x1, OEM = 0x2, REQUEST_TARGET = 0x4, NTLM = 0x200, ALWAYS_SIGN = 0x8000, ESS = 0x80000, N128 = 0x20000000, N56 = 0x80000000;
const FLAGS = (UNICODE | OEM | REQUEST_TARGET | NTLM | ALWAYS_SIGN | ESS | N128 | N56) >>> 0;
const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');
const hmac = (key, ...data) => crypto.createHmac('md5', key).update(Buffer.concat(data)).digest();
const utf16 = (s) => Buffer.from(s, 'utf16le');

/** 'DOMAIN\user' or 'user@domain.tld' → { user, domain }. */
function splitUser(name) {
  const s = String(name ?? '');
  const bs = s.indexOf('\\');
  if (bs >= 0) return { domain: s.slice(0, bs), user: s.slice(bs + 1) };
  const at = s.lastIndexOf('@');
  if (at > 0) return { domain: s.slice(at + 1), user: s.slice(0, at) };
  return { domain: '', user: s };
}

function negotiate() {
  const m = Buffer.alloc(32);
  SIGNATURE.copy(m);
  m.writeUInt32LE(1, 8);
  m.writeUInt32LE(FLAGS, 12);
  return m;
}

function parseChallenge(buf) {
  if (buf.length < 32 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.readUInt32LE(8) !== 2) throw new Error('NTLM: risposta del server non valida');
  const flags = buf.readUInt32LE(20);
  const challenge = buf.subarray(24, 32);
  let targetInfo = Buffer.alloc(0);
  if (buf.length >= 48) {
    const len = buf.readUInt16LE(40);
    const off = buf.readUInt32LE(44);
    targetInfo = buf.subarray(off, off + len);
  }
  return { flags, challenge, targetInfo };
}

/** MsvAvTimestamp of the target info, when the server sends one (the client must then use it). */
function avTimestamp(info) {
  for (let i = 0; i + 4 <= info.length;) {
    const id = info.readUInt16LE(i);
    const len = info.readUInt16LE(i + 2);
    if (id === 0) break;
    if (id === 7 && len === 8) return info.subarray(i + 4, i + 12);
    i += 4 + len;
  }
  return null;
}

const ntowfv2 = (password, user, domain) => hmac(md4(utf16(password)), utf16(user.toUpperCase() + domain));

/** NTLMv2 responses; clientChallenge/timestamp are fixed only in tests. */
function responses(key, serverChallenge, targetInfo, clientChallenge = crypto.randomBytes(8), timestamp = null) {
  let ts = timestamp ?? avTimestamp(targetInfo);
  if (!ts) {
    ts = Buffer.alloc(8);
    ts.writeBigUInt64LE((BigInt(Date.now()) + 11644473600000n) * 10000n);
  }
  const blob = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), ts, clientChallenge, Buffer.alloc(4), targetInfo, Buffer.alloc(4)]);
  const proof = hmac(key, serverChallenge, blob);
  return { nt: Buffer.concat([proof, blob]), lm: Buffer.concat([hmac(key, serverChallenge, clientChallenge), clientChallenge]), proof };
}

function authenticate(challengeMsg, username, password, workstation = '') {
  const { flags, challenge, targetInfo } = parseChallenge(challengeMsg);
  const { user, domain } = splitUser(username);
  const { nt, lm } = responses(ntowfv2(password ?? '', user, domain), challenge, targetInfo);
  const fields = [lm, nt, utf16(domain), utf16(user), utf16(workstation), Buffer.alloc(0)];
  const head = Buffer.alloc(64);
  SIGNATURE.copy(head);
  head.writeUInt32LE(3, 8);
  let off = 64;
  fields.forEach((f, i) => {
    head.writeUInt16LE(f.length, 12 + i * 8);
    head.writeUInt16LE(f.length, 14 + i * 8);
    head.writeUInt32LE(off, 16 + i * 8);
    off += f.length;
  });
  head.writeUInt32LE((flags & FLAGS) >>> 0 || FLAGS, 60);
  return Buffer.concat([head, ...fields]);
}

module.exports = { md4, splitUser, negotiate, parseChallenge, authenticate, ntowfv2, responses };
