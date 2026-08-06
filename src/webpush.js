// Web Push sender on pure WebCrypto — no Node APIs — so the scheduled Worker can
// fan out notifications (the `web-push` npm lib needs Node's https/crypto and
// cannot run in workerd). Implements:
//   RFC 8291  Message Encryption for Web Push (ECDH P-256 + HKDF + AES-128-GCM,
//             content coding aes128gcm, single record)
//   RFC 8188  Encrypted Content-Encoding (the body framing: salt|rs|idlen|keyid)
//   RFC 8292  VAPID (ES256 JWT in `Authorization: vapid t=...,k=...`)
//
// Verified against a receiver-side decrypt in scripts/test-webpush.mjs — run it
// with `node scripts/test-webpush.mjs` after touching ANYTHING here.
//
// Works in both workerd and Node ≥ 18 (globalThis.crypto).

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

// ---- base64url <-> bytes (no Buffer; atob/btoa exist in workerd and Node ≥ 16) --
export const b64u = {
  decode(s) {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  },
  encode(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
};

const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// HKDF-SHA256 (extract + expand in one WebCrypto call)
async function hkdf(salt, ikm, info, len) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// RFC 8291 §3.4: encrypt `plaintext` for a subscription's (p256dh, auth) keys.
// Returns the complete aes128gcm request body (header + single record).
export async function encryptPayload(plaintext, p256dhB64u, authB64u) {
  const uaPublicRaw = b64u.decode(p256dhB64u); // 65-byte uncompressed P-256 point
  const authSecret = b64u.decode(authB64u);    // 16 bytes

  // ephemeral application-server ECDH keypair (fresh per message, per spec)
  const asKeys = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicRaw = new Uint8Array(await subtle.exportKey("raw", asKeys.publicKey));

  const uaPublicKey = await subtle.importKey("raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeys.privateKey, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info"||0x00||ua_public||as_public, 32)
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // single record: plaintext || 0x02 (last-record delimiter), AES-128-GCM
  const record = concat(typeof plaintext === "string" ? enc.encode(plaintext) : plaintext, new Uint8Array([2]));
  const aesKey = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // RFC 8188 header: salt(16) | rs(4, BE) | idlen(1) | keyid(=as_public, 65)
  const rs = 4096;
  const header = concat(salt, new Uint8Array([rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublicRaw.length]), asPublicRaw);
  return concat(header, ciphertext);
}

// RFC 8292: ES256-signed JWT for the push service origin. The private key is the
// web-push-format base64url 32-byte scalar; `publicKeyB64u` its 65-byte point.
export async function vapidHeader(endpoint, publicKeyB64u, privateKeyB64u, subject) {
  const pub = b64u.decode(publicKeyB64u); // 0x04 || x(32) || y(32)
  const jwk = {
    kty: "EC", crv: "P-256",
    x: b64u.encode(pub.slice(1, 33)),
    y: b64u.encode(pub.slice(33, 65)),
    d: privateKeyB64u,
  };
  const key = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const aud = new URL(endpoint).origin;
  const seg = (o) => b64u.encode(enc.encode(JSON.stringify(o)));
  const signing = `${seg({ typ: "JWT", alg: "ES256" })}.${seg({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  // WebCrypto ECDSA emits raw r||s (64 bytes) — exactly the JWS ES256 form
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signing)));
  return `vapid t=${signing}.${b64u.encode(sig)}, k=${publicKeyB64u}`;
}

/**
 * Encrypt + POST one push message. Mirrors web-push's sendNotification enough
 * for src/push-core.js's fanOut: throws an Error with `.statusCode` on a non-2xx
 * response (410/404 = subscription gone → caller prunes).
 *
 * @param {{endpoint:string, keys:{p256dh:string, auth:string}}} subscription
 * @param {string} payload
 * @param {{publicKey:string, privateKey:string, subject:string, ttl?:number}} vapid
 */
export async function sendNotification(subscription, payload, vapid) {
  const body = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);
  const auth = await vapidHeader(subscription.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(vapid.ttl ?? 3600), // a "now live" alert is worthless a day later
      Urgency: "high",
    },
    body,
  });
  if (!res.ok) {
    const err = new Error(`push ${res.status} for ${subscription.endpoint.slice(0, 60)}…`);
    err.statusCode = res.status;
    throw err;
  }
}
