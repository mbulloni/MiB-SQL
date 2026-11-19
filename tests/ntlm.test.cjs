const test = require('node:test');
const assert = require('node:assert/strict');
const ntlm = require('../electron/ntlm.cjs');

const hex = (b) => Buffer.from(b).toString('hex');

test('MD4 test vectors (RFC 1320)', () => {
  assert.equal(hex(ntlm.md4('')), '31d6cfe0d16ae931b73c59d7e0c089c0');
  assert.equal(hex(ntlm.md4('abc')), 'a448017aaf21d8525fc10ae87aa6729d');
  assert.equal(hex(ntlm.md4('message digest')), 'd9130a8164549fe818874806e1c7014b');
  assert.equal(hex(ntlm.md4('12345678901234567890123456789012345678901234567890123456789012345678901234567890')), 'e33b4ddc9c38f2199c3e7b164fcc0536');
});

test('NTLMv2 responses match MS-NLMP 4.2.4', () => {
  const key = ntlm.ntowfv2('Password', 'User', 'Domain');
  assert.equal(hex(key), '0c868a403bfd7a93a3001ef22ef02e3f');
  const av = (id, s) => { const v = Buffer.from(s, 'utf16le'); const h = Buffer.alloc(4); h.writeUInt16LE(id); h.writeUInt16LE(v.length, 2); return Buffer.concat([h, v]); };
  const info = Buffer.concat([av(2, 'Domain'), av(1, 'Server'), Buffer.alloc(4)]);
  const r = ntlm.responses(key, Buffer.from('0123456789abcdef', 'hex'), info, Buffer.alloc(8, 0xaa), Buffer.alloc(8));
  assert.equal(hex(r.proof), '68cd0ab851e51c96aabc927bebef6a1c');
  assert.equal(hex(r.lm), '86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa');
});

test('user name forms', () => {
  assert.deepEqual(ntlm.splitUser('RETE\\FEDER185'), { domain: 'RETE', user: 'FEDER185' });
  assert.deepEqual(ntlm.splitUser('mario@rete.local'), { domain: 'rete.local', user: 'mario' });
  assert.deepEqual(ntlm.splitUser('mario'), { domain: '', user: 'mario' });
});

test('authenticate message carries user, domain and an NTLMv2 response', () => {
  const ch = Buffer.alloc(56);
  Buffer.from('NTLMSSP\0', 'latin1').copy(ch);
  ch.writeUInt32LE(2, 8);
  ch.writeUInt32LE(0xa2898205, 20);
  Buffer.from('0123456789abcdef', 'hex').copy(ch, 24);
  ch.writeUInt16LE(4, 40); ch.writeUInt16LE(4, 42); ch.writeUInt32LE(48, 44);
  const m = ntlm.authenticate(ch, 'RETE\\mario', 'x');
  assert.equal(m.readUInt32LE(8), 3);
  const field = (i) => m.subarray(m.readUInt32LE(16 + i * 8), m.readUInt32LE(16 + i * 8) + m.readUInt16LE(12 + i * 8));
  assert.equal(field(2).toString('utf16le'), 'RETE');
  assert.equal(field(3).toString('utf16le'), 'mario');
  assert.equal(field(1).length, 16 + 28 + 4 + 4);
});
