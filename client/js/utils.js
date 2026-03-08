/**
 * Shared utility functions for the OpenClaw Relay client.
 */

export function b64Encode(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function b64Decode(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function concatBuffers(...bufs) {
  const total = bufs.reduce((s, b) => s + b.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const b of bufs) {
    result.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return result;
}

export function randomHex(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function generateMsgId() {
  return 'msg_' + randomHex(4);
}
