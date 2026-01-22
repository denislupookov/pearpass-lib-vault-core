import * as appDeps from './appDeps'
import * as decryptVaultKeyModule from './decryptVaultKey'
import { masterPasswordManager } from './masterPasswordManager'

jest.mock('./appDeps', () => ({
  encryptionAdd: jest.fn(),
  encryptionGet: jest.fn(),
  getIsEncryptionInitialized: jest.fn(),
  encryptionInit: jest.fn(),
  encryptVaultKeyWithHashedPassword: jest.fn(),
  encryptVaultWithKey: jest.fn(),
  getDecryptionKey: jest.fn(),
  hashPassword: jest.fn(),
  rateLimitRecordFailure: jest.fn(),
  vaultsAdd: jest.fn(),
  closeVaultsInstance: jest.fn(),
  vaultsGet: jest.fn(),
  getIsVaultsInitialized: jest.fn(),
  vaultsInit: jest.fn()
}))

jest.mock('./decryptVaultKey', () => ({
  decryptVaultKey: jest.fn()
}))

describe('masterPasswordManager', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('createMasterPassword', () => {
    it('creates and stores master password data', async () => {
      appDeps.getIsEncryptionInitialized.mockReturnValue(false)
      appDeps.encryptionGet.mockResolvedValue(undefined)
      appDeps.hashPassword.mockReturnValue({
        hashedPassword: 'hashed',
        salt: 'salt'
      })
      appDeps.encryptVaultKeyWithHashedPassword.mockReturnValue({
        ciphertext: 'ct',
        nonce: 'nonce'
      })
      decryptVaultKeyModule.decryptVaultKey.mockReturnValue('vault-key')
      appDeps.getIsVaultsInitialized.mockReturnValue(false)

      const result =
        await masterPasswordManager.createMasterPassword('pw-base64')

      expect(appDeps.encryptionInit).toHaveBeenCalled()
      expect(appDeps.hashPassword).toHaveBeenCalledWith('pw-base64')
      expect(appDeps.encryptVaultKeyWithHashedPassword).toHaveBeenCalledWith(
        'hashed'
      )
      expect(appDeps.vaultsInit).toHaveBeenCalledWith('vault-key')
      expect(appDeps.vaultsAdd).toHaveBeenCalledWith('masterEncryption', {
        ciphertext: 'ct',
        nonce: 'nonce',
        salt: 'salt',
        hashedPassword: 'hashed'
      })
      expect(appDeps.encryptionAdd).toHaveBeenCalledWith('masterPassword', {
        ciphertext: 'ct',
        nonce: 'nonce',
        salt: 'salt'
      })
      expect(result).toEqual({
        hashedPassword: 'hashed',
        salt: 'salt',
        ciphertext: 'ct',
        nonce: 'nonce'
      })
    })
  })

  describe('initWithPassword', () => {
    it('validates against existing vaults master encryption', async () => {
      appDeps.getIsVaultsInitialized.mockReturnValue(true)
      appDeps.vaultsGet.mockResolvedValue({
        salt: 'salt',
        hashedPassword: 'derived'
      })
      appDeps.getDecryptionKey.mockReturnValue('derived')

      const result = await masterPasswordManager.initWithPassword('pw-base64')

      expect(appDeps.getDecryptionKey).toHaveBeenCalledWith({
        salt: 'salt',
        password: 'pw-base64'
      })
      expect(result).toEqual({ success: true })
    })

    it('records failure when decrypting fails', async () => {
      appDeps.getIsVaultsInitialized.mockReturnValue(false)
      appDeps.getIsEncryptionInitialized.mockReturnValue(true)
      appDeps.encryptionGet.mockResolvedValue({
        ciphertext: 'ct',
        nonce: 'nonce',
        salt: 'salt'
      })
      appDeps.getDecryptionKey.mockReturnValue('derived')
      decryptVaultKeyModule.decryptVaultKey.mockReturnValue(undefined)

      await expect(
        masterPasswordManager.initWithPassword('pw-base64')
      ).rejects.toThrow('Error decrypting vault key')

      expect(appDeps.rateLimitRecordFailure).toHaveBeenCalled()
    })
  })

  describe('updateMasterPassword', () => {
    it('updates master password after verifying current one', async () => {
      appDeps.getIsEncryptionInitialized.mockReturnValue(true)
      appDeps.getIsVaultsInitialized.mockReturnValueOnce(true)
      appDeps.vaultsGet.mockResolvedValue({
        ciphertext: 'old-ct',
        nonce: 'old-nonce',
        salt: 'old-salt',
        hashedPassword: 'current-hash'
      })
      appDeps.getDecryptionKey.mockReturnValueOnce('current-hash')
      decryptVaultKeyModule.decryptVaultKey
        .mockReturnValueOnce('vault-key')
        .mockReturnValueOnce('vault-key')
      appDeps.hashPassword.mockReturnValue({
        hashedPassword: 'new-hash',
        salt: 'new-salt'
      })
      appDeps.encryptVaultWithKey.mockReturnValue({
        ciphertext: 'new-ct',
        nonce: 'new-nonce'
      })
      appDeps.getIsVaultsInitialized.mockReturnValue(true)

      const result = await masterPasswordManager.updateMasterPassword({
        newPassword: 'new-pw',
        currentPassword: 'curr-pw'
      })

      expect(appDeps.getDecryptionKey).toHaveBeenCalledWith({
        salt: 'old-salt',
        password: 'curr-pw'
      })
      expect(appDeps.hashPassword).toHaveBeenCalledWith('new-pw')
      expect(appDeps.encryptVaultWithKey).toHaveBeenCalledWith(
        'new-hash',
        'vault-key'
      )
      expect(appDeps.vaultsAdd).toHaveBeenCalledWith('masterEncryption', {
        ciphertext: 'new-ct',
        nonce: 'new-nonce',
        salt: 'new-salt',
        hashedPassword: 'new-hash'
      })
      expect(appDeps.encryptionAdd).toHaveBeenCalledWith('masterPassword', {
        ciphertext: 'new-ct',
        nonce: 'new-nonce',
        salt: 'new-salt'
      })
      expect(result).toEqual({
        hashedPassword: 'new-hash',
        salt: 'new-salt',
        ciphertext: 'new-ct',
        nonce: 'new-nonce'
      })
    })
  })

  describe('initWithCredentials', () => {
    it('initializes vaults with provided credentials', async () => {
      appDeps.getIsEncryptionInitialized.mockReturnValue(false)
      decryptVaultKeyModule.decryptVaultKey.mockReturnValue('vault-key')
      appDeps.vaultsInit.mockResolvedValue()

      const result = await masterPasswordManager.initWithCredentials({
        ciphertext: 'ct',
        nonce: 'nonce',
        hashedPassword: 'hash'
      })

      expect(appDeps.encryptionInit).toHaveBeenCalled()
      expect(decryptVaultKeyModule.decryptVaultKey).toHaveBeenCalledWith({
        ciphertext: 'ct',
        nonce: 'nonce',
        hashedPassword: 'hash'
      })
      expect(appDeps.vaultsInit).toHaveBeenCalledWith('vault-key')
      expect(result).toEqual({ success: true })
    })

    it('throws error if required parameters are missing', async () => {
      await expect(
        masterPasswordManager.initWithCredentials({})
      ).rejects.toThrow('Missing required parameters')

      await expect(
        masterPasswordManager.initWithCredentials({
          ciphertext: 'ct',
          nonce: 'nonce'
        })
      ).rejects.toThrow('Missing required parameters')
    })

    it('throws error if decryption fails', async () => {
      appDeps.getIsEncryptionInitialized.mockReturnValue(true)
      decryptVaultKeyModule.decryptVaultKey.mockReturnValue(undefined)

      await expect(
        masterPasswordManager.initWithCredentials({
          ciphertext: 'ct',
          nonce: 'nonce',
          hashedPassword: 'hash'
        })
      ).rejects.toThrow('Error decrypting vault key')
    })
  })
})
