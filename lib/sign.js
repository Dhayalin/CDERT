'use strict';
/* ECDSA P-256 signing for "bulletins": compact snapshots that nearby devices can pass to each other
   offline. Browsers verify them with WebCrypto and the cached public key, so a forged bulletin is rejected. */
const crypto = require('crypto');
function makeKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: publicKey.export({ format: 'jwk' }) };
}
function sign(keys, payload) {
  return crypto.sign('sha256', Buffer.from(payload), { key: keys.priv, dsaEncoding: 'ieee-p1363' }).toString('base64');
}
module.exports = { makeKeys, sign };
