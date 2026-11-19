// Client-side decryption for the encrypted static gallery export.
//
// File format: "LOL1" || iv(12) || ciphertext || authTag(16), AES-256-GCM.
// The key is PBKDF2-SHA-256(secret, salt, iterations); salt and iterations are
// public (keyinfo.json). The secret is shared via the URL fragment (#k=...),
// which browsers never send to the server, or typed into the unlock box.

export function readSecret() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return params.get("k") || sessionStorage.getItem("lol-gallery-secret") || "";
}

export function saveSecret(secret) {
  sessionStorage.setItem("lol-gallery-secret", secret);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function deriveKey(secret, keyinfo) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64ToBytes(keyinfo.salt),
      iterations: keyinfo.iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

// `buffer` is an encrypted file; resolves to the decrypted bytes.
// AES-GCM expects ciphertext||tag, which is exactly how the export writes it.
export async function decryptFile(key, buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "LOL1") {
    throw new Error("Not an encrypted gallery file.");
  }
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(4, 16), tagLength: 128 },
    key,
    bytes.subarray(16),
  );
}
