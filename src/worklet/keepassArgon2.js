import { argon2d, argon2id } from '@noble/hashes/argon2.js'
import sodium from 'sodium-native'

import { workletLogger } from './utils/workletLogger'

// Defensive upper bounds on KDF parameters. The KDBX 4 header is
// attacker-controlled (threat model: "user opens a malicious .kdbx"), so a
// crafted file with absurd iterations/memory would otherwise hard-block the
// worklet thread or OOM the process. Fail fast with a clear reason instead.
const MAX_ARGON2_ITERATIONS = 100
const MAX_ARGON2_MEMORY_KIB = 1024 * 1024 // 1 GiB
const MAX_ARGON2_PARALLELISM = 16
const MIN_ARGON2_KEY_LENGTH = 16
const MAX_ARGON2_KEY_LENGTH = 64

// Stable error code so the UI can distinguish "unsupported file" from
// "wrong password" without string-matching the message.
const keepassError = (code, message) => {
  const err = new Error(message)
  err.code = code
  return err
}

// Copy a transient secret (a plain Buffer / Uint8Array) into libsodium secure
// memory, then wipe the original so the only surviving copy lives in a buffer
// we can memzero.
const toSecureBuffer = (bytes) => {
  const secure = sodium.sodium_malloc(bytes.length)
  secure.set(bytes)
  bytes.fill(0)
  return secure
}

/**
 * Run the Argon2 KDF for a KeePass (KDBX 4) database off the React Native JS
 * thread. kdbxweb derives the master key by calling its `setArgon2Impl` hook;
 * on the host that hook delegates here so the memory-hard KDF runs on Bare's
 * JIT-enabled V8 instead of freezing Hermes for minutes.
 *
 * Mirrors the Bitwarden worklet decryption: the host keeps the format parsing
 * (kdbxweb / XML), the worklet only runs the heavy crypto primitive.
 *
 * @param {Object} params
 * @param {string} params.password    - base64-encoded password bytes
 * @param {string} params.salt        - base64-encoded KDF salt
 * @param {'argon2d'|'argon2id'} params.type
 * @param {number} params.memory      - memory cost in KiB
 * @param {number} params.iterations  - time cost (passes)
 * @param {number} params.parallelism - lanes
 * @param {number} params.length      - derived key length in bytes
 * @param {number} params.version     - Argon2 version (0x10 or 0x13)
 * @returns {string} base64-encoded derived key
 */
export const keepassArgon2 = ({
  password,
  salt,
  type,
  memory,
  iterations,
  parallelism,
  length,
  version
}) => {
  if (type !== 'argon2d' && type !== 'argon2id') {
    throw keepassError(
      'KEEPASS_UNSUPPORTED_KDF',
      `Unsupported Argon2 type: ${type}`
    )
  }
  if (version !== 0x10 && version !== 0x13) {
    throw keepassError(
      'KEEPASS_UNSUPPORTED_KDF',
      `Unsupported Argon2 version: ${version}`
    )
  }
  if (
    !(iterations > 0) ||
    iterations > MAX_ARGON2_ITERATIONS ||
    !(memory > 0) ||
    memory > MAX_ARGON2_MEMORY_KIB ||
    !(parallelism > 0) ||
    parallelism > MAX_ARGON2_PARALLELISM ||
    !(length >= MIN_ARGON2_KEY_LENGTH) ||
    length > MAX_ARGON2_KEY_LENGTH
  ) {
    throw keepassError(
      'KEEPASS_UNSUPPORTED_KDF',
      `Argon2 parameters out of range (t=${iterations} memKiB=${memory} p=${parallelism} dkLen=${length})`
    )
  }

  const passwordBuf = toSecureBuffer(Buffer.from(password, 'base64'))
  const saltBuf = toSecureBuffer(Buffer.from(salt, 'base64'))

  workletLogger.info(
    `[keepass-worklet] argon2 type=${type} v=${version} t=${iterations} memKiB=${memory} p=${parallelism} dkLen=${length} pwLen=${passwordBuf.length} saltLen=${saltBuf.length}`
  )

  const hashFn = type === 'argon2id' ? argon2id : argon2d

  try {
    const t = Date.now()
    const derived = hashFn(passwordBuf, saltBuf, {
      t: iterations,
      m: memory,
      p: parallelism,
      dkLen: length,
      version
    })
    workletLogger.info(`[keepass-worklet] Argon2 done in ${Date.now() - t}ms`)
    try {
      return Buffer.from(derived).toString('base64')
    } finally {
      derived.fill(0)
    }
  } finally {
    sodium.sodium_memzero(passwordBuf)
    sodium.sodium_memzero(saltBuf)
    sodium.sodium_free(passwordBuf)
    sodium.sodium_free(saltBuf)
  }
}
