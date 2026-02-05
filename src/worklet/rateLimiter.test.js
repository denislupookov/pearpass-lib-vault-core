import { RateLimiter } from './rateLimiter'

const DEFAULT_DATA = {
  consecutiveFailures: 0,
  lockoutUntil: null,
  lastAttemptTime: null
}

describe('RateLimiter', () => {
  let rateLimiter
  let mockStorage

  beforeEach(async () => {
    rateLimiter = new RateLimiter()
    mockStorage = {
      get: jest.fn(),
      add: jest.fn()
    }
    await rateLimiter.setStorage(mockStorage)
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  test('should set storage', () => {
    expect(rateLimiter.storage).toBe(mockStorage)
  })

  test('should throw error when storage is not provided', async () => {
    const newRateLimiter = new RateLimiter()
    await expect(newRateLimiter.setStorage(null)).rejects.toThrow(
      'Storage must have get and add methods'
    )
  })

  describe('Exponential Backoff Calculation', () => {
    test('should allow first 4 attempts without lockout', () => {
      for (let i = 1; i <= 4; i++) {
        const backoffMs = rateLimiter.calculateBackoffDuration(i)
        expect(backoffMs).toBe(0) // No lockout
      }
    })

    test('should calculate exponential backoff: 5th attempt = 2 minutes', () => {
      const backoffMs = rateLimiter.calculateBackoffDuration(5)
      expect(backoffMs).toBe(2 * 60 * 1000) // 2^(5-5+1) = 2 minutes
    })

    test('should calculate exponential backoff: 6th attempt = 4 minutes', () => {
      const backoffMs = rateLimiter.calculateBackoffDuration(6)
      expect(backoffMs).toBe(4 * 60 * 1000) // 2^(6-5+1) = 4 minutes
    })

    test('should calculate exponential backoff: 7th attempt = 8 minutes', () => {
      const backoffMs = rateLimiter.calculateBackoffDuration(7)
      expect(backoffMs).toBe(8 * 60 * 1000) // 2^(7-5+1) = 8 minutes
    })

    test('should calculate exponential backoff: 8th attempt = 16 minutes', () => {
      const backoffMs = rateLimiter.calculateBackoffDuration(8)
      expect(backoffMs).toBe(16 * 60 * 1000) // 2^(8-5+1) = 16 minutes
    })

    test('should calculate exponential backoff: 9th attempt = 32 minutes', () => {
      const backoffMs = rateLimiter.calculateBackoffDuration(9)
      expect(backoffMs).toBe(32 * 60 * 1000) // 2^(9-5+1) = 32 minutes
    })

    test('should cap backoff duration at maximum (24 hours)', () => {
      const backoffMs = rateLimiter.calculateBackoffDuration(1000)
      const maxMs = 24 * 60 * 60 * 1000
      expect(backoffMs).toBe(maxMs)
    })

    test('should return 0 for attempts below MAX_ATTEMPTS (5)', () => {
      expect(rateLimiter.calculateBackoffDuration(0)).toBe(0)
      expect(rateLimiter.calculateBackoffDuration(1)).toBe(0)
      expect(rateLimiter.calculateBackoffDuration(4)).toBe(0)
    })
  })

  test('should increment consecutive failures', async () => {
    mockStorage.add.mockResolvedValue()
    mockStorage.get.mockResolvedValue({
      consecutiveFailures: 2,
      lockoutUntil: null,
      lastAttemptTime: null
    })

    await rateLimiter.recordFailure()

    expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', {
      consecutiveFailures: 3,
      lockoutUntil: null,
      lastAttemptTime: expect.any(Number)
    })
  })

  test('should allow first 4 attempts without lockout', async () => {
    mockStorage.add.mockResolvedValue()
    jest.spyOn(Date, 'now').mockReturnValue(1000000)

    for (let i = 1; i <= 4; i++) {
      mockStorage.get.mockResolvedValueOnce({
        consecutiveFailures: i - 1,
        lockoutUntil: null,
        lastAttemptTime: null
      })

      await rateLimiter.recordFailure()

      expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', {
        consecutiveFailures: i,
        lockoutUntil: null,
        lastAttemptTime: 1000000
      })
    }
  })

  test('should set exponential lockout on 5th failure (first lockout)', async () => {
    mockStorage.add.mockResolvedValue()
    jest.spyOn(Date, 'now').mockReturnValue(1000000)
    mockStorage.get.mockResolvedValue({
      consecutiveFailures: 4,
      lockoutUntil: null,
      lastAttemptTime: null
    })

    await rateLimiter.recordFailure()

    expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', {
      consecutiveFailures: 5,
      lockoutUntil: 1000000 + 2 * 60 * 1000,
      lastAttemptTime: 1000000
    })
  })

  test('should set exponential lockout on 6th failure', async () => {
    mockStorage.add.mockResolvedValue()
    jest.spyOn(Date, 'now').mockReturnValue(1000000)
    mockStorage.get.mockResolvedValue({
      consecutiveFailures: 5,
      lockoutUntil: null,
      lastAttemptTime: null
    })

    await rateLimiter.recordFailure()

    expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', {
      consecutiveFailures: 6,
      lockoutUntil: 1000000 + 4 * 60 * 1000,
      lastAttemptTime: 1000000
    })
  })

  test('should continue counter when expired lockout exists', async () => {
    mockStorage.add.mockResolvedValue()
    const pastTime = Date.now() - 10000
    mockStorage.get.mockResolvedValue({
      consecutiveFailures: 5,
      lockoutUntil: pastTime,
      lastAttemptTime: pastTime
    })

    await rateLimiter.recordFailure()

    expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', {
      consecutiveFailures: 6,
      lockoutUntil: expect.any(Number),
      lastAttemptTime: expect.any(Number)
    })
  })

  test('should return unlocked status when no lockout', async () => {
    mockStorage.add.mockResolvedValue()
    mockStorage.get.mockResolvedValue({
      consecutiveFailures: 2,
      lockoutUntil: null,
      lastAttemptTime: null
    })

    const result = await rateLimiter.getStatus()

    expect(result).toEqual({
      isLocked: false,
      lockoutRemainingMs: 0,
      remainingAttempts: 3 // 5 - 2 = 3 attempts left
    })
    expect(mockStorage.add).not.toHaveBeenCalled()
  })

  test('should show unlocked when lockout expired (counter persists)', async () => {
    mockStorage.add.mockResolvedValue()
    const pastTime = Date.now() - 10000
    mockStorage.get.mockResolvedValue({
      consecutiveFailures: 5,
      lockoutUntil: pastTime,
      lastAttemptTime: pastTime
    })

    const result = await rateLimiter.getStatus()

    expect(result).toEqual({
      isLocked: false,
      lockoutRemainingMs: 0,
      remainingAttempts: 0
    })
    expect(mockStorage.add).not.toHaveBeenCalled()
  })

  test('should return locked status when lockout is active', async () => {
    mockStorage.add.mockResolvedValue()
    jest.spyOn(Date, 'now').mockReturnValue(1000000)
    mockStorage.get.mockResolvedValue({
      consecutiveFailures: 5,
      lockoutUntil: 1060000,
      lastAttemptTime: 1000000
    })

    const result = await rateLimiter.getStatus()

    expect(result).toEqual({
      isLocked: true,
      lockoutRemainingMs: 60000,
      remainingAttempts: 0
    })
  })

  test('should reset to default data', async () => {
    mockStorage.add.mockResolvedValue()

    await rateLimiter.reset()

    expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', DEFAULT_DATA)
  })

  test('should return remaining attempts when unlocked', async () => {
    mockStorage.get.mockResolvedValue({
      consecutiveFailures: 2,
      lockoutUntil: null,
      lastAttemptTime: null
    })

    const remaining = await rateLimiter.getRemainingAttempts()

    expect(remaining).toBe(3)
  })

  test('should return 0 remaining attempts when locked out', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000000)
    mockStorage.get.mockResolvedValue({
      consecutiveFailures: 5,
      lockoutUntil: 1060000,
      lastAttemptTime: 1000000
    })

    const remaining = await rateLimiter.getRemainingAttempts()

    expect(remaining).toBe(0)
  })

  describe('Security checks, loading behavior', () => {
    test('getData should return safe default on storage read error', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1000000)
      mockStorage.get.mockRejectedValue(new Error('Storage corrupted'))

      const data = await rateLimiter.getData()

      expect(data.consecutiveFailures).toBe(1)
      expect(data.lockoutUntil).toBe(1000000)
      expect(data.lastAttemptTime).toBe(1000000)
    })

    test('getStatus should return unlocked when storage fails (safe default)', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1000000)
      mockStorage.get.mockRejectedValue(new Error('Storage quota exceeded'))

      const status = await rateLimiter.getStatus()

      expect(status.isLocked).toBe(false)
      expect(status.remainingAttempts).toBe(0)
      expect(status.lockoutRemainingMs).toBe(0)
    })

    test('recordFailure should throw when storage operations fail', async () => {
      mockStorage.get.mockRejectedValue(new Error('Storage unavailable'))
      mockStorage.add.mockRejectedValue(new Error('Write failed'))

      await expect(rateLimiter.recordFailure()).rejects.toThrow(
        'Failed to record attempt - denying access'
      )
    })

    test('recordFailure should throw when storage.add fails', async () => {
      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 2,
        lockoutUntil: null
      })
      mockStorage.add.mockRejectedValue(new Error('Write failed'))

      await expect(rateLimiter.recordFailure()).rejects.toThrow(
        'Failed to record attempt - denying access'
      )
    })

    test('getData should return DEFAULT_DATA when no data exists on first load', async () => {
      mockStorage.get.mockResolvedValue(null)

      const data = await rateLimiter.getData()

      expect(data.consecutiveFailures).toBe(0)
      expect(data.lockoutUntil).toBeNull()
    })

    test('getData should return DEFAULT_DATA when undefined is returned on first load', async () => {
      mockStorage.get.mockResolvedValue(undefined)

      const data = await rateLimiter.getData()

      expect(data.consecutiveFailures).toBe(0)
      expect(data.lockoutUntil).toBeNull()
    })
  })

  describe('Backoff Progression and Reset Behavior', () => {
    test('should progressively increase lockout duration through failures', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(1000000)

      mockStorage.get.mockResolvedValueOnce({
        consecutiveFailures: 4,
        lockoutUntil: null,
        lastAttemptTime: null
      })
      await rateLimiter.recordFailure()
      let addCall =
        mockStorage.add.mock.calls[mockStorage.add.mock.calls.length - 1]
      let lockoutTime = addCall[1].lockoutUntil
      expect(lockoutTime).toBe(1000000 + 2 * 60 * 1000) // 2 minutes

      mockStorage.get.mockResolvedValueOnce({
        consecutiveFailures: 5,
        lockoutUntil: null,
        lastAttemptTime: 1000000
      })
      await rateLimiter.recordFailure()
      addCall =
        mockStorage.add.mock.calls[mockStorage.add.mock.calls.length - 1]
      lockoutTime = addCall[1].lockoutUntil
      expect(lockoutTime).toBe(1000000 + 4 * 60 * 1000) // 4 minutes

      // 7th failure
      mockStorage.get.mockResolvedValueOnce({
        consecutiveFailures: 6,
        lockoutUntil: null,
        lastAttemptTime: 1000000
      })
      await rateLimiter.recordFailure()
      addCall =
        mockStorage.add.mock.calls[mockStorage.add.mock.calls.length - 1]
      lockoutTime = addCall[1].lockoutUntil
      expect(lockoutTime).toBe(1000000 + 8 * 60 * 1000) // 8 minutes

      mockStorage.get.mockResolvedValueOnce({
        consecutiveFailures: 7,
        lockoutUntil: null,
        lastAttemptTime: 1000000
      })
      await rateLimiter.recordFailure()
      addCall =
        mockStorage.add.mock.calls[mockStorage.add.mock.calls.length - 1]
      lockoutTime = addCall[1].lockoutUntil
      expect(lockoutTime).toBe(1000000 + 16 * 60 * 1000) // 16 minutes
    })

    test('should reset consecutive failures on reset', async () => {
      mockStorage.add.mockResolvedValue()

      await rateLimiter.reset()

      expect(mockStorage.add).toHaveBeenCalledWith(
        'rateLimitData',
        DEFAULT_DATA
      )
    })

    test('should NOT reset consecutive failures after lockout expires - counter persists', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(1000000)
      const pastTime = Date.now() - 10000

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 5,
        lockoutUntil: pastTime,
        lastAttemptTime: pastTime
      })

      await rateLimiter.recordFailure()

      expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', {
        consecutiveFailures: 6,
        lockoutUntil: 1000000 + 4 * 60 * 1000, // 2^2 = 4 minutes
        lastAttemptTime: 1000000
      })
    })

    test('should continue consecutive failures counter during active lockout', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(1000000)
      const futureTime = Date.now() + 100000

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 5,
        lockoutUntil: futureTime,
        lastAttemptTime: 900000
      })

      await rateLimiter.recordFailure()

      expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', {
        consecutiveFailures: 6,
        lockoutUntil: expect.any(Number),
        lastAttemptTime: 1000000
      })
    })

    test('should calculate lockout remaining time correctly', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(1000000)
      const lockoutEnd = 1000000 + 60000

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 5,
        lockoutUntil: lockoutEnd,
        lastAttemptTime: 1000000
      })

      const status = await rateLimiter.getStatus()

      expect(status.lockoutRemainingMs).toBe(60000)
    })

    test('should handle maximum backoff cap correctly', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(1000000)

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 100,
        lockoutUntil: null,
        lastAttemptTime: null
      })

      await rateLimiter.recordFailure()

      const addCall = mockStorage.add.mock.calls[0]
      const lockoutTime = addCall[1].lockoutUntil
      const maxLockoutMs = 24 * 60 * 60 * 1000

      expect(lockoutTime - 1000000).toBe(maxLockoutMs)
    })
  })

  describe('Cool-down Period (Fresh Start)', () => {
    const COOLDOWN_PERIOD_MS = 24 * 60 * 60 * 1000

    test('should grant fresh start after 24 hours of inactivity', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(2000000)
      const oldTime = 2000000 - COOLDOWN_PERIOD_MS - 1000

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 5,
        lockoutUntil: 1500000,
        lastAttemptTime: oldTime
      })

      const status = await rateLimiter.getStatus()

      expect(status).toEqual({
        isLocked: false,
        lockoutRemainingMs: 0,
        remainingAttempts: 5
      })
      expect(mockStorage.add).toHaveBeenCalledWith(
        'rateLimitData',
        DEFAULT_DATA
      )
    })

    test('should grant fresh start in getRemainingAttempts after cool-down', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(2000000)
      const oldTime = 2000000 - COOLDOWN_PERIOD_MS - 1

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 5,
        lockoutUntil: null,
        lastAttemptTime: oldTime
      })

      const remaining = await rateLimiter.getRemainingAttempts()

      expect(remaining).toBe(5)
    })

    test('should reset counter on recordFailure after cool-down expires', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(2000000)
      const oldTime = 2000000 - COOLDOWN_PERIOD_MS - 1000

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 8,
        lockoutUntil: 1500000,
        lastAttemptTime: oldTime
      })

      await rateLimiter.recordFailure()

      expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', {
        consecutiveFailures: 1,
        lockoutUntil: null,
        lastAttemptTime: 2000000
      })
    })

    test('should NOT grant fresh start if cool-down period not reached', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(2000000)
      const recentTime = 2000000 - COOLDOWN_PERIOD_MS + 10000 // 23h50m ago

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 6,
        lockoutUntil: 1900000, // Expired lockout
        lastAttemptTime: recentTime
      })

      const status = await rateLimiter.getStatus()

      expect(status).toEqual({
        isLocked: false,
        lockoutRemainingMs: 0,
        remainingAttempts: 0 // 5 - 6 = 0 (capped)
      })
      expect(mockStorage.add).not.toHaveBeenCalled()
    })

    test('should NOT reset if lastAttemptTime is null', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(2000000)

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 3,
        lockoutUntil: null,
        lastAttemptTime: null // Never attempted
      })

      const status = await rateLimiter.getStatus()

      expect(status).toEqual({
        isLocked: false,
        lockoutRemainingMs: 0,
        remainingAttempts: 2 // 5 - 3 = 2
      })
      expect(mockStorage.add).not.toHaveBeenCalled()
    })

    test('should reset during active lockout if cool-down expired', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(2000000)
      const oldTime = 2000000 - COOLDOWN_PERIOD_MS - 5000
      const futureLockout = 2000000 + 100000

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 7,
        lockoutUntil: futureLockout,
        lastAttemptTime: oldTime
      })

      const status = await rateLimiter.getStatus()

      expect(status).toEqual({
        isLocked: false,
        lockoutRemainingMs: 0,
        remainingAttempts: 5
      })
      expect(mockStorage.add).toHaveBeenCalledWith(
        'rateLimitData',
        DEFAULT_DATA
      )
    })

    test('should continue exponential progression after lockout expires (no cool-down)', async () => {
      mockStorage.add.mockResolvedValue()
      jest.spyOn(Date, 'now').mockReturnValue(2000000)
      const recentTime = 2000000 - 60000
      const expiredLockout = 1950000

      mockStorage.get.mockResolvedValue({
        consecutiveFailures: 5,
        lockoutUntil: expiredLockout,
        lastAttemptTime: recentTime
      })

      await rateLimiter.recordFailure()

      expect(mockStorage.add).toHaveBeenCalledWith('rateLimitData', {
        consecutiveFailures: 6,
        lockoutUntil: 2000000 + 4 * 60 * 1000, // 2^2 = 4 minutes
        lastAttemptTime: 2000000
      })
    })

    test('should update lastAttemptTime on every recordFailure', async () => {
      mockStorage.add.mockResolvedValue()
      const timestamps = [1000000, 1100000, 1200000]

      for (let i = 0; i < timestamps.length; i++) {
        jest.spyOn(Date, 'now').mockReturnValue(timestamps[i])

        mockStorage.get.mockResolvedValueOnce({
          consecutiveFailures: i,
          lockoutUntil: null,
          lastAttemptTime: i > 0 ? timestamps[i - 1] : null
        })

        await rateLimiter.recordFailure()

        const addCall =
          mockStorage.add.mock.calls[mockStorage.add.mock.calls.length - 1]
        expect(addCall[1].lastAttemptTime).toBe(timestamps[i])
      }
    })
  })
})
