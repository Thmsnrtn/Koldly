/**
 * Retry Service Tests
 */

const RetryService = require('../lib/retry-service');

describe('RetryService', () => {
  describe('execute', () => {
    test('should succeed on first try', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      const result = await RetryService.execute(operation, { maxRetries: 3 });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should retry on transient error then succeed', async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce('success');

      const result = await RetryService.execute(operation, {
        maxRetries: 3,
        initialDelay: 10, // Use short delay for tests
        backoffMultiplier: 2
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should fail after max retries exceeded', async () => {
      const operation = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        RetryService.execute(operation, {
          maxRetries: 2,
          initialDelay: 10
        })
      ).rejects.toThrow('Operation failed after 3 attempts');

      expect(operation).toHaveBeenCalledTimes(3);
    });

    test('should not retry non-retryable errors', async () => {
      const error = new Error('Invalid input');
      error.status = 400; // Bad request - not retryable
      const operation = jest.fn().mockRejectedValue(error);

      await expect(
        RetryService.execute(operation, {
          maxRetries: 3,
          initialDelay: 10
        })
      ).rejects.toThrow('Invalid input');

      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should retry 500 errors', async () => {
      const error = new Error('Internal Server Error');
      error.status = 500;
      const operation = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('recovered');

      const result = await RetryService.execute(operation, {
        maxRetries: 3,
        initialDelay: 10
      });

      expect(result).toBe('recovered');
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('isRetryable', () => {
    test('should detect timeout errors as retryable', () => {
      const error = new Error('ETIMEDOUT');
      expect(RetryService.isRetryable(error)).toBe(true);
    });

    test('should detect network errors as retryable', () => {
      const errors = [
        new Error('ECONNREFUSED'),
        new Error('ECONNRESET'),
        new Error('ENOTFOUND')
      ];
      errors.forEach(err => {
        expect(RetryService.isRetryable(err)).toBe(true);
      });
    });

    test('should detect connection timeout messages as retryable', () => {
      const error = new Error('connection timeout');
      expect(RetryService.isRetryable(error)).toBe(true);
    });

    test('should not retry 4xx errors', () => {
      const error = new Error('Bad Request');
      error.status = 400;
      expect(RetryService.isRetryable(error)).toBe(false);
    });

    test('should retry 5xx errors', () => {
      const error = new Error('Server Error');
      error.status = 503;
      expect(RetryService.isRetryable(error)).toBe(true);
    });
  });
});
