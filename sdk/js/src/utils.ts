import { webcrypto } from 'node:crypto';

const nodeCrypto = globalThis.crypto ?? webcrypto;

export function getWebCrypto(): Crypto {
  return nodeCrypto as Crypto;
}

export function b64Encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

export function b64Decode(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

export function concatBuffers(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getWebCrypto().getRandomValues(bytes);
  return bytes;
}

export function randomHex(byteLength = 8): string {
  return Buffer.from(randomBytes(byteLength)).toString('hex');
}

export function generateMsgId(): string {
  return `msg_${randomHex(4)}`;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await getWebCrypto().subtle.digest('SHA-256', toArrayBuffer(data));
  return Buffer.from(new Uint8Array(digest)).toString('hex');
}

export async function channelTokenHash(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  return await sha256Hex(data);
}
