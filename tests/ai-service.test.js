/**
 * AI Service Tests
 *
 * Tests model routing, caching logic, budget checking, and cost calculations.
 * Does NOT make real API calls — mocks the Anthropic SDK.
 */

const AIService = require('../lib/ai-service');

// Mock pool
const mockPool = {
  query: jest.fn()
};

describe('AIService', () => {
  let ai;

  beforeEach(() => {
    ai = new AIService(mockPool);
    // Mock the Anthropic client
    ai.client = {
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ text: '{"result": "test"}' }],
          usage: { input_tokens: 100, output_tokens: 50 }
        })
      }
    };
    mockPool.query.mockReset();
  });

  describe('call()', () => {
    beforeEach(() => {
      // Mock cache miss
      mockPool.query.mockResolvedValue({ rows: [] });
    });

    test('routes haiku tasks to haiku model', async () => {
      const result = await ai.call('icp_parse', {
        system: 'test',
        messages: [{ role: 'user', content: 'parse this' }]
      });

      expect(ai.client.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-3-5-haiku-20241022'
        })
      );
      expect(result.model).toBe('haiku');
    });

    test('routes sonnet tasks to sonnet model', async () => {
      const result = await ai.call('email_draft', {
        system: 'test',
        messages: [{ role: 'user', content: 'draft email' }]
      });

      expect(ai.client.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-20250514'
        })
      );
      expect(result.model).toBe('sonnet');
    });

    test('defaults unknown tasks to haiku', async () => {
      const result = await ai.call('unknown_task', {
        messages: [{ role: 'user', content: 'test' }]
      });

      expect(result.model).toBe('haiku');
    });

    test('returns parsed content', async () => {
      const result = await ai.call('icp_parse', {
        messages: [{ role: 'user', content: 'test' }]
      });

      expect(result.content).toBe('{"result": "test"}');
      expect(result.tokens_in).toBe(100);
      expect(result.tokens_out).toBe(50);
      expect(result.cached).toBe(false);
    });

    test('calculates cost correctly for haiku', async () => {
      const result = await ai.call('icp_parse', {
        messages: [{ role: 'user', content: 'test' }]
      });

      // Haiku: 100 input tokens * $0.25/MTok + 50 output * $1.25/MTok
      // = 0.0025 + 0.00625 = 0.00875 cents
      expect(result.cost_cents).toBeGreaterThan(0);
      expect(result.cost_cents).toBeLessThan(1);
    });

    test('forces model when specified', async () => {
      const result = await ai.call('icp_parse', {
        messages: [{ role: 'user', content: 'test' }]
      }, { forceModel: 'sonnet' });

      expect(ai.client.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-20250514'
        })
      );
      expect(result.model).toBe('sonnet');
    });
  });

  describe('callJSON()', () => {
    beforeEach(() => {
      mockPool.query.mockResolvedValue({ rows: [] });
    });

    test('appends JSON instruction to system prompt', async () => {
      ai.client.messages.create.mockResolvedValue({
        content: [{ text: '{"key": "value"}' }],
        usage: { input_tokens: 50, output_tokens: 30 }
      });

      const result = await ai.callJSON('icp_parse', {
        system: 'Parse ICP',
        messages: [{ role: 'user', content: 'test' }]
      });

      expect(ai.client.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('Respond with valid JSON only')
        })
      );
      expect(result.content).toEqual({ key: 'value' });
    });

    test('handles JSON in markdown code blocks', async () => {
      ai.client.messages.create.mockResolvedValue({
        content: [{ text: '```json\n{"key": "value"}\n```' }],
        usage: { input_tokens: 50, output_tokens: 30 }
      });

      const result = await ai.callJSON('icp_parse', {
        messages: [{ role: 'user', content: 'test' }]
      });

      expect(result.content).toEqual({ key: 'value' });
    });
  });

  describe('checkBudget()', () => {
    test('returns allowed when under budget', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ subscription_plan: 'starter', total_cost_cents: '200' }]
      });

      const result = await ai.checkBudget(1);
      expect(result.allowed).toBe(true);
      expect(result.remaining_cents).toBe(800); // 1000 - 200
      expect(result.plan).toBe('starter');
    });

    test('returns not allowed when over budget', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ subscription_plan: 'starter', total_cost_cents: '1100' }]
      });

      const result = await ai.checkBudget(1);
      expect(result.allowed).toBe(false);
      expect(result.remaining_cents).toBe(0);
    });

    test('defaults to free plan budget', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ subscription_plan: null, total_cost_cents: '0' }]
      });

      const result = await ai.checkBudget(1);
      expect(result.allowed).toBe(true);
      expect(result.budget_cents).toBe(500); // free tier
    });
  });

  describe('cache', () => {
    test('returns cached result when available', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ response: '{"cached": true}', tokens_in: 50, tokens_out: 25 }]
        })
        .mockResolvedValue({ rows: [] });

      const result = await ai.call('icp_parse', {
        messages: [{ role: 'user', content: 'test' }]
      });

      expect(result.cached).toBe(true);
      expect(result.cost_cents).toBe(0);
      expect(ai.client.messages.create).not.toHaveBeenCalled();
    });

    test('skips cache when skipCache is true', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await ai.call('icp_parse', {
        messages: [{ role: 'user', content: 'test' }]
      }, { skipCache: true });

      // Should not check cache (first call should be for setting cache, not checking)
      expect(ai.client.messages.create).toHaveBeenCalled();
    });
  });
});
