export function b64Encode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function b64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function arrayBufferFrom(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return value.slice(0);
}

export function concatBuffers(...buffers: ArrayBufferView[]): Uint8Array {
  const total = buffers.reduce((sum, item) => sum + item.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    result.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), offset);
    offset += buffer.byteLength;
  }
  return result;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', arrayBufferFrom(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function publicKeyFingerprint(publicKeyBytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(publicKeyBytes)}`;
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(byteLength = 18): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, byteLength * 2);
}

export function generateMessageId(): string {
  return `msg_${randomHex(4)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
