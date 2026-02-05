const MAX_ATTEMPTS = 5
const MAX_BACKOFF_MINUTES = 24 * 60 // 24 hours
const COOLDOWN_PERIOD_MS = MAX_BACKOFF_MINUTES * 60 * 1000
const STORAGE_KEY = 'rateLimitData'

const DEFAULT_DATA = {
  consecutiveFailures: 0,
  lockoutUntil: null,
  lastAttemptTime: null
}

export class RateLimiter {
  constructor() {
    /**
     * @type {{ get: Function, add: Function } | null}
     */
    this.storage = null
  }

  async setStorage(storage) {
    if (!storage) {
      throw new Error('Storage must have get and add methods')
    }
    this.storage = storage
  }

  /**
   * @param {number} consecutiveFailures
   * @returns {number}
   */
  calculateBackoffDuration(consecutiveFailures) {
    if (consecutiveFailures < MAX_ATTEMPTS) {
      return 0
    }

    const exponent = consecutiveFailures - MAX_ATTEMPTS + 1
    const backoffMinutes = Math.pow(2, exponent)
    const cappedMinutes = Math.min(backoffMinutes, MAX_BACKOFF_MINUTES)

    return cappedMinutes * 60 * 1000
  }

  async getData() {
    if (!this.storage) {
      throw new Error('Storage not initialized.')
    }

    try {
      const data = await this.storage.get(STORAGE_KEY)
      return data || { ...DEFAULT_DATA }
    } catch {
      const backoffMs = this.calculateBackoffDuration(1)
      return {
        consecutiveFailures: 1,
        lockoutUntil: Date.now() + backoffMs,
        lastAttemptTime: Date.now()
      }
    }
  }

  isLockoutExpired(lockoutUntil) {
    if (lockoutUntil === null) {
      return true
    }
    return Date.now() >= lockoutUntil
  }

  /**
   * @param {number|null} lastAttemptTime
   * @returns {boolean}
   */
  shouldGrantFreshStart(lastAttemptTime) {
    if (lastAttemptTime === null) {
      return false
    }
    return Date.now() - lastAttemptTime >= COOLDOWN_PERIOD_MS
  }

  async getStatus() {
    const data = await this.getData()

    if (this.shouldGrantFreshStart(data.lastAttemptTime)) {
      await this.reset()
      return {
        isLocked: false,
        lockoutRemainingMs: 0,
        remainingAttempts: MAX_ATTEMPTS
      }
    }

    if (
      data.lockoutUntil !== null &&
      this.isLockoutExpired(data.lockoutUntil)
    ) {
      return {
        isLocked: false,
        lockoutRemainingMs: 0,
        remainingAttempts: 0
      }
    }

    const isLocked = data.lockoutUntil !== null
    const lockoutRemainingMs = data.lockoutUntil
      ? Math.max(0, data.lockoutUntil - Date.now())
      : 0

    const remainingAttempts = isLocked
      ? 0
      : Math.max(0, MAX_ATTEMPTS - data.consecutiveFailures)

    return { isLocked, lockoutRemainingMs, remainingAttempts }
  }

  async getRemainingAttempts() {
    const data = await this.getData()

    if (this.shouldGrantFreshStart(data.lastAttemptTime)) {
      return MAX_ATTEMPTS
    }

    if (
      data.lockoutUntil !== null &&
      !this.isLockoutExpired(data.lockoutUntil)
    ) {
      return 0
    }

    return Math.max(0, MAX_ATTEMPTS - data.consecutiveFailures)
  }

  async recordFailure() {
    let data
    try {
      data = await this.getData()
    } catch {
      throw new Error('Rate limiter unavailable - denying attempt')
    }

    if (this.shouldGrantFreshStart(data.lastAttemptTime)) {
      data.consecutiveFailures = 0
      data.lockoutUntil = null
    }

    if (
      data.lockoutUntil !== null &&
      this.isLockoutExpired(data.lockoutUntil)
    ) {
      data.lockoutUntil = null
    }

    data.consecutiveFailures++
    data.lastAttemptTime = Date.now()

    const backoffMs = this.calculateBackoffDuration(data.consecutiveFailures)
    if (backoffMs > 0) {
      data.lockoutUntil = Date.now() + backoffMs
    } else {
      data.lockoutUntil = null
    }

    try {
      await this.storage.add(STORAGE_KEY, data)
    } catch {
      throw new Error('Failed to record attempt - denying access')
    }
  }

  async reset() {
    await this.storage.add(STORAGE_KEY, { ...DEFAULT_DATA })
  }
}
