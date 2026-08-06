// Roundtrip test for src/webpush.js (the WebCrypto Web Push sender the scheduled
// Worker uses). No network: we play the BROWSER side ourselves — generate a
// subscription keypair, encrypt with our sender code, then decrypt with an
// independent implementation of the receiver steps from RFC 8291 §3.4 / RFC 8188
// and check the plaintext survives. Also verifies the VAPID JWT's ES256 signature
// and claims. Run: node scripts/test-webpush.mjs   (exits non-zero on failure)
import { encryptPayload, vapidHeader, b64u } from "../src/webpush.js";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
async function hkdf(salt, ikm, info, len) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// ---- 1. encryption roundtrip -------------------------------------------------
// the "browser": its ECDH keypair + auth secret, exactly what a real
// PushSubscription exposes as keys.p256dh / keys.auth
const ua = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPublicRaw = new Uint8Array(await subtle.exportKey("raw", ua.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));

const msg = JSON.stringify({ title: "🔴 Live: Coello/Tapia vs Galán/Chingotto", body: "Premier Padel · Final", url: "https://padelticker.com/" });
const bodyBytes = await encryptPayload(msg, b64u.encode(uaPublicRaw), b64u.encode(authSecret));

// receiver side, straight from the RFCs (independent of src/webpush.js internals)
const salt = bodyBytes.slice(0, 16);
const rs = (bodyBytes[16] << 24) | (bodyBytes[17] << 16) | (bodyBytes[18] << 8) | bodyBytes[19];
const idlen = bodyBytes[20];
const asPublicRaw = bodyBytes.slice(21, 21 + idlen);
const ciphertext = bodyBytes.slice(21 + idlen);
check("header shape", rs === 4096 && idlen === 65, `rs=${rs} idlen=${idlen}`);

const asPub = await subtle.importKey("raw", asPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asPub }, ua.privateKey, 256));
const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublicRaw, asPublicRaw), 32);
const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
const aesKey = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
let plaintext = null;
try {
  const record = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext));
  check("record delimiter", record[record.length - 1] === 2);
  plaintext = dec.decode(record.slice(0, -1));
} catch (e) {
  check("AES-GCM decrypt", false, e.message);
}
check("plaintext roundtrip", plaintext === msg);

// a tampered body must NOT decrypt (auth tag integrity)
const tampered = bodyBytes.slice();
tampered[tampered.length - 1] ^= 1;
let tamperedOk = false;
try { await subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, tampered.slice(21 + idlen)); tamperedOk = true; } catch {}
check("tampering detected", !tamperedOk);

// ---- 2. VAPID JWT ------------------------------------------------------------
// a fresh VAPID keypair in web-push's storage format (b64url scalar / b64url point)
const vk = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const vjwk = await subtle.exportKey("jwk", vk.privateKey);
const vapidPub = b64u.encode(concat(new Uint8Array([4]), b64u.decode(vjwk.x), b64u.decode(vjwk.y)));
const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
const header = await vapidHeader(endpoint, vapidPub, vjwk.d, "mailto:test@example.com");

const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
check("header format", !!m && m[2] === vapidPub);
if (m) {
  const [h, p, s] = m[1].split(".");
  const claims = JSON.parse(dec.decode(b64u.decode(p)));
  check("claims", claims.aud === "https://fcm.googleapis.com" && claims.sub === "mailto:test@example.com" &&
    claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600, JSON.stringify(claims));
  const verifyKey = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: vjwk.x, y: vjwk.y },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, b64u.decode(s), enc.encode(`${h}.${p}`));
  check("ES256 signature verifies", valid);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall webpush checks passed");
process.exit(failures ? 1 : 0);
