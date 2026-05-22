// Argon2 at realistic KDBX parameters can take a few hundred ms in @noble's
// pure-JS implementation. Raise the timeout so the suite doesn't flake on CI.
jest.setTimeout(30_000)

jest.mock('./utils/workletLogger', () => ({
  workletLogger: {
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}))

import { argon2d, argon2id } from '@noble/hashes/argon2.js'

import { keepassArgon2 } from './keepassArgon2'

const PASSWORD = Buffer.from('correct horse battery staple', 'utf8')
const SALT = Buffer.from('keepass-kdf-salt', 'utf8')

// Modest cost so the suite stays fast; the wiring under test is identical at
// production parameters.
const BASE_PARAMS = {
  password: PASSWORD.toString('base64'),
  salt: SALT.toString('base64'),
  type: 'argon2id',
  memory: 256,
  iterations: 2,
  parallelism: 1,
  length: 32,
  version: 0x13
}

describe('keepassArgon2', () => {
  describe('happy path', () => {
    it('derives the same key as noble argon2id and returns it base64-encoded', () => {
      const expected = Buffer.from(
        argon2id(PASSWORD, SALT, {
          t: 2,
          m: 256,
          p: 1,
          dkLen: 32,
          version: 0x13
        })
      ).toString('base64')

      expect(keepassArgon2(BASE_PARAMS)).toBe(expected)
    })

    it('uses argon2d when type is argon2d', () => {
      const expected = Buffer.from(
        argon2d(PASSWORD, SALT, {
          t: 2,
          m: 256,
          p: 1,
          dkLen: 32,
          version: 0x13
        })
      ).toString('base64')

      expect(keepassArgon2({ ...BASE_PARAMS, type: 'argon2d' })).toBe(expected)
    })

    it('produces different keys for argon2d vs argon2id', () => {
      expect(keepassArgon2({ ...BASE_PARAMS, type: 'argon2d' })).not.toBe(
        keepassArgon2({ ...BASE_PARAMS, type: 'argon2id' })
      )
    })

    it('honours the requested key length', () => {
      const derived = Buffer.from(
        keepassArgon2({ ...BASE_PARAMS, length: 64 }),
        'base64'
      )
      expect(derived).toHaveLength(64)
    })
  })

  describe('input validation', () => {
    it('rejects an unsupported Argon2 type', () => {
      expect.assertions(2)
      try {
        keepassArgon2({ ...BASE_PARAMS, type: 'argon2i' })
      } catch (err) {
        expect(err.message).toMatch(/Unsupported Argon2 type/)
        expect(err.code).toBe('KEEPASS_UNSUPPORTED_KDF')
      }
    })

    it('rejects an unsupported Argon2 version', () => {
      expect.assertions(1)
      try {
        keepassArgon2({ ...BASE_PARAMS, version: 0x99 })
      } catch (err) {
        expect(err.code).toBe('KEEPASS_UNSUPPORTED_KDF')
      }
    })

    it('rejects iterations above the safety ceiling', () => {
      expect(() => keepassArgon2({ ...BASE_PARAMS, iterations: 1000 })).toThrow(
        'Argon2 parameters out of range'
      )
    })

    it('rejects memory above the safety ceiling', () => {
      expect(() =>
        keepassArgon2({ ...BASE_PARAMS, memory: 2 * 1024 * 1024 })
      ).toThrow('Argon2 parameters out of range')
    })

    it('rejects a zero / negative time cost', () => {
      expect(() => keepassArgon2({ ...BASE_PARAMS, iterations: 0 })).toThrow(
        'Argon2 parameters out of range'
      )
    })

    it('rejects an out-of-range key length', () => {
      expect(() => keepassArgon2({ ...BASE_PARAMS, length: 8 })).toThrow(
        'Argon2 parameters out of range'
      )
    })
  })
})
