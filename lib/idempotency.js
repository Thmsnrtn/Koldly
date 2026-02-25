/**
 * Idempotency Service - Prevent duplicate operations
 *
 * Tracks operation keys to prevent duplicates from accidental double-clicks
 * or network retries.
 *
 * Usage:
 *   // In route handler
 *   const idempotencyKey = req.body.idempotencyKey || generateIdempotencyKey();
 *   const result = await idempotencyService.execute(
 *     idempotencyKey,
 *     async () => { return await createCampaign(...) },
 *     { ttl: 3600 } // 1 hour
 *   );
 */

class IdempotencyService {
  constructor() {
    // In-memory store of completed operations
    // In production, this should use Redis
    this.operations = new Map();
    this.results = new Map();
  }

  /**
   * Generate a unique idempotency key
   * @returns {string}
   */
  static generateKey() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Execute operation idempotently
   * If same key is used twice, returns cached result without re-executing
   *
   * @param {string} key - Idempotency key (e.g., from request body)
   * @param {Function} operation - Async function to execute
   * @param {Object} options - Configuration
   * @returns {Promise} Operation result
   */
  async execute(key, operation, options = {}) {
    const { ttl = 3600 } = options; // Default 1 hour TTL

    // Check if operation already completed
    if (this.results.has(key)) {
      console.log(`[Idempotency] Cache hit for key: ${key}`);
      return this.results.get(key);
    }

    // Check if operation is in-flight
    if (this.operations.has(key)) {
      console.log(`[Idempotency] Waiting for in-flight operation: ${key}`);
      // Return the existing promise (in-flight operation)
      return this.operations.get(key);
    }

    // Create promise for this operation
    const promise = (async () => {
      try {
        const result = await operation();
        // Cache the result
        this.results.set(key, result);
        // Auto-cleanup after TTL
        setTimeout(() => {
          this.operations.delete(key);
          this.results.delete(key);
        }, ttl * 1000);
        return result;
      } catch (error) {
        // Don't cache errors - allow retry
        this.operations.delete(key);
        throw error;
      }
    })();

    // Mark operation as in-flight
    this.operations.set(key, promise);

    return promise;
  }

  /**
   * Clear all cached operations (for testing)
   */
  clear() {
    this.operations.clear();
    this.results.clear();
  }

  /**
   * Get stats about cached operations
   * @returns {Object}
   */
  getStats() {
    return {
      inFlight: this.operations.size,
      cached: this.results.size,
      total: this.operations.size + this.results.size
    };
  }
}

module.exports = new IdempotencyService();
