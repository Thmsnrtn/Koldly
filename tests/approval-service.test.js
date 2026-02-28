/**
 * Approval Service Tests
 */

const ApprovalService = require('../lib/approval-service');

const mockPool = { query: jest.fn() };

describe('ApprovalService', () => {
  let service;

  beforeEach(() => {
    service = new ApprovalService(mockPool);
    mockPool.query.mockReset();
  });

  describe('getQueueCounts()', () => {
    test('returns correct counts', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })
        .mockResolvedValueOnce({ rows: [{ count: '3' }] });

      const counts = await service.getQueueCounts(1);
      expect(counts.emails).toBe(5);
      expect(counts.replies).toBe(3);
      expect(counts.total).toBe(8);
    });
  });

  describe('approveEmail()', () => {
    test('approves and updates prospect status', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1, prospect_id: 10 }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.approveEmail(1, 1);
      expect(result.status).toBe('approved');
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    test('throws when email not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(service.approveEmail(999, 1))
        .rejects.toThrow('Email not found or already processed');
    });
  });

  describe('rejectEmail()', () => {
    test('rejects and reverts prospect to researched', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1, prospect_id: 10 }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.rejectEmail(1, 1, 'not good enough');
      expect(result.status).toBe('rejected');
    });
  });

  describe('bulkApproveEmails()', () => {
    test('approves multiple emails', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            { id: 1, prospect_id: 10 },
            { id: 2, prospect_id: 11 },
            { id: 3, prospect_id: 12 }
          ]
        })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.bulkApproveEmails([1, 2, 3], 1);
      expect(result.approved).toBe(3);
      expect(result.ids).toEqual([1, 2, 3]);
    });
  });

  describe('approveReplyDraft()', () => {
    test('approves reply draft', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });

      const result = await service.approveReplyDraft(5, 1);
      expect(result.status).toBe('approved');
    });

    test('throws when draft not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(service.approveReplyDraft(999, 1))
        .rejects.toThrow('Reply draft not found or already processed');
    });
  });
});
