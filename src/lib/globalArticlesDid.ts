// Vendored + trimmed from tc-news's src/crypto/didIdentity.ts (itself
// copied from tc-storage — see notes-tc-news.md §3(a)/§2). tc-presenter
// never mints or signs with its own DID: it only reads the `tc-global-
// articles` room, so all it ever needs is to verify the `fromId` DID on an
// incoming wire. This file keeps only the verify-side primitives
// (isEd25519DidKey, verifyStringWithDid) and the tiny base58/base64 decoders
// they depend on — no keypair generation, no identity persistence.

const ed25519Algorithm = { name: 'Ed25519' }
const ed25519PublicKeyMulticodec = new Uint8Array([0xed, 0x01])
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
}

function decodeBase58(value: string): Uint8Array {
  if (!value) return new Uint8Array()
  let leadingZeroCount = 0
  while (leadingZeroCount < value.length && value[leadingZeroCount] === base58Alphabet[0]) leadingZeroCount += 1
  if (leadingZeroCount === value.length) return new Uint8Array(leadingZeroCount)

  const bytes = [0]
  for (let charIndex = leadingZeroCount; charIndex < value.length; charIndex += 1) {
    const char = value[charIndex]
    const digit = base58Alphabet.indexOf(char)
    if (digit < 0) throw new Error('Invalid base58btc character')
    let carry = digit
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry
      bytes[index] = next & 0xff
      carry = next >> 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  return new Uint8Array([...new Uint8Array(leadingZeroCount), ...bytes.reverse()])
}

function ed25519PublicKeyFromMultibase(publicKeyMultibase: string): Uint8Array {
  if (!publicKeyMultibase.startsWith('z')) throw new Error('DID key must use base58btc multibase')
  const bytes = decodeBase58(publicKeyMultibase.slice(1))
  if (bytes.length !== 34 || bytes[0] !== ed25519PublicKeyMulticodec[0] || bytes[1] !== ed25519PublicKeyMulticodec[1]) {
    throw new Error('DID key is not an Ed25519 public key')
  }
  return bytes.slice(2)
}

function ed25519PublicKeyFromDidKey(did: string): Uint8Array | undefined {
  if (!did.startsWith('did:key:')) return undefined
  try {
    return ed25519PublicKeyFromMultibase(did.slice('did:key:'.length))
  } catch {
    return undefined
  }
}

export function isEd25519DidKey(did: string): boolean {
  return ed25519PublicKeyFromDidKey(did) !== undefined
}

export async function verifyStringWithDid(did: string, payload: string, signature: string): Promise<boolean> {
  const publicKeyRaw = ed25519PublicKeyFromDidKey(did)
  if (!publicKeyRaw) return false
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return false
  const publicKey = await subtle.importKey('raw', toArrayBuffer(publicKeyRaw), ed25519Algorithm, false, ['verify'])
  return subtle.verify(
    ed25519Algorithm,
    publicKey,
    toArrayBuffer(base64ToBytes(fromBase64Url(signature))),
    new TextEncoder().encode(payload),
  )
}
