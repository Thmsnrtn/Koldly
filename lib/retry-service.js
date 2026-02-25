/**
 * Retry Service - Exponential backoff with jitter
 *
 * Provides retry logic for transient failures:
 * - Network timeouts
 * - Temporary service unavailability
 * - Neon database cold-starts
 *
 * Usage:
 *   const result = await retryOperation(
 *     () => fetch(url),
 *     { maxRetries: 3, initialDelay: 100 }
 *   );
 */

class RetryService {
  /**
   * Retry an async operation with exponential backoff
   * @param {Function} operation - Async function to retry
   * @param {Object} options - Retry configuration
   * @returns {Promise} Result of operation
   */
  static async execute(operation, options = {}) {
    const {
      maxRetries = 3,
      initialDelay = 100,
      maxDelay = 5000,
      backoffMultiplier = 2,
      shouldRetry = this.isRetryable
    } = options;

    let lastError = null;
    let delay = initialDelay;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Don't retry if we've exhausted attempts
        if (attempt === maxRetries) {
          break;
        }

        // Check if error is retryable
        if (!shouldRetry(error)) {
          throw error;
        }

        // Calculate delay with jitter
        const jitter = Math.random() * 0.1 * delay;
        const actualDelay = Math.min(delay + jitter, maxDelay);

        console.warn(
          `[Retry] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${error.message}. ` +
          `Retrying in ${Math.round(actualDelay)}ms`
        );

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, actualDelay));

        // Increase delay for next attempt
        delay = Math.min(delay * backoffMultiplier, maxDelay);
      }
    }

    throw new Error(
      `Operation failed after ${maxRetries + 1} attempts: ${lastError.message}`
    );
  }

  /**
   * Determine if an error is retryable
   * @param {Error} error
   * @returns {boolean}
   */
  static isRetryable(error) {
    // Timeout errors
    if (error.code === 'ETIMEDOUT' || error.code === 'EHOSTUNREACH') {
      return true;
    }

    // Network errors
    if (error.message.includes('ECONNREFUSED') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('ENOTFOUND')) {
      return true;
    }

    // HTTP 5xx errors are retryable
    if (error.status >= 500) {
      return true;
    }

    // Database connection errors
    if (error.message.includes('connection') ||
        error.message.includes('timeout')) {
      return true;
    }

    return false;
  }

  /**
   * Wrap a fetch call with retry logic
   * @param {string} url
   * @param {Object} options - Fetch options
   * @returns {Promise}
   */
  static async fetchWithRetry(url, options = {}) {
    const retryOptions = {
      maxRetries: options.maxRetries || 3,
      initialDelay: options.initialDelay || 100
    };

    return this.execute(
      () => fetch(url, options),
      retryOptions
    );
  }
}

module.exports = RetryService;
