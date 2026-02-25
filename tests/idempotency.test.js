/**
 * Idempotency Service Tests
 */

const idempotencyService = require('../lib/idempotency');

describe('IdempotencyService', () => {
  beforeEach(() => {
    // Clear cache before each test
    idempotencyService.clear();
  });

  describe('execute', () => {
    test('should execute operation once on first call', async () => {
      const operation = jest.fn().mockResolvedValue('result');
      const key = 'test-key-1';

      const result = await idempotencyService.execute(key, operation);

      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should return cached result on second call with same key', async () => {
      const operation = jest.fn().mockResolvedValue('result');
      const key = 'test-key-2';

      const result1 = await idempotencyService.execute(key, operation);
      const result2 = await idempotencyService.execute(key, operation);

      expect(result1).toBe('result');
      expect(result2).toBe('result');
      // Operation should only be called once
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should handle concurrent requests with same key', async () => {
      const operation = jest.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve('result'), 100))
      );
      const key = 'concurrent-key';

      // Launch two concurrent requests with same key
      const promise1 = idempotencyService.execute(key, operation);
      const promise2 = idempotencyService.execute(key, operation);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe('result');
      expect(result2).toBe('result');
      // Operation should only be called once despite concurrent requests
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should not cache errors', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('First attempt fails'))
        .mockResolvedValueOnce('Second attempt succeeds');
      const key = 'error-test';

      // First call fails
      await expect(idempotencyService.execute(key, operation)).rejects.toThrow(
        'First attempt fails'
      );

      // Second call should retry, not return cached error
      const result = await idempotencyService.execute(key, operation);
      expect(result).toBe('Second attempt succeeds');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should respect TTL for cached results', async () => {
      const operation = jest.fn().mockResolvedValue('result');
      const key = 'ttl-test';

      const result1 = await idempotencyService.execute(key, operation, { ttl: 0.1 });
      expect(result1).toBe('result');
      expect(operation).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 200));

      // Call again after TTL - should execute operation again
      const result2 = await idempotencyService.execute(key, operation, { ttl: 0.1 });
      expect(result2).toBe('result');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should differentiate between different keys', async () => {
      const operation1 = jest.fn().mockResolvedValue('result1');
      const operation2 = jest.fn().mockResolvedValue('result2');

      const result1 = await idempotencyService.execute('key-1', operation1);
      const result2 = await idempotencyService.execute('key-2', operation2);

      expect(result1).toBe('result1');
      expect(result2).toBe('result2');
      expect(operation1).toHaveBeenCalledTimes(1);
      expect(operation2).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStats', () => {
    test('should track in-flight and cached operations', async () => {
      const operation = jest.fn().mockResolvedValue('result');

      await idempotencyService.execute('key-1', operation);
      const stats = idempotencyService.getStats();

      expect(stats.cached).toBeGreaterThan(0);
    });
  });

  describe('generateKey', () => {
    test('should generate unique keys', () => {
      const key1 = idempotencyService.constructor.generateKey();
      const key2 = idempotencyService.constructor.generateKey();

      expect(key1).not.toBe(key2);
      expect(key1).toMatch(/^\d+-[a-z0-9]+$/);
    });
  });
});
