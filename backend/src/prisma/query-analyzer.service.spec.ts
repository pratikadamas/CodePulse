import { Test, TestingModule } from '@nestjs/testing';
import {
  QueryAnalyzerService,
  SlowQueryCostExceededError,
  UnindexedSequentialScanError,
} from './query-analyzer.service';

describe('QueryAnalyzerService', () => {
  let service: QueryAnalyzerService;

  beforeEach(async () => {
    delete process.env.ENABLE_QUERY_ANALYZER;
    process.env.NODE_ENV = 'test';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: QueryAnalyzerService,
          useFactory: () =>
            new QueryAnalyzerService({
              maxEstimatedCost: 5000,
              largeTableRowThreshold: 10000,
              enforceErrorsInCI: true,
            }),
        },
      ],
    }).compile();

    service = module.get<QueryAnalyzerService>(QueryAnalyzerService);
  });

  afterEach(() => {
    delete process.env.ENABLE_QUERY_ANALYZER;
    process.env.NODE_ENV = 'test';
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(service.isEnabled()).toBe(true);
  });

  describe('Zero Overhead in Production', () => {
    it('should disable analyzer in production by default', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ENABLE_QUERY_ANALYZER;

      expect(service.isEnabled()).toBe(false);
    });

    it('should allow explicit opt-in in production via ENABLE_QUERY_ANALYZER=true', () => {
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_QUERY_ANALYZER = 'true';

      expect(service.isEnabled()).toBe(true);
    });

    it('should bypass analysis and return instantly when disabled', async () => {
      process.env.ENABLE_QUERY_ANALYZER = 'false';

      const analysis = await service.interceptFindMany('DeveloperRating', {
        where: { xp: 1000, elo: 1500 },
      });

      expect(analysis.passed).toBe(true);
      expect(analysis.totalCost).toBe(0);
      expect(analysis.diagnostics).toContain('disabled in production');
    });
  });

  describe('Query Cost Threshold Detection (> 5,000 cost)', () => {
    it('should pass queries within the 5,000 estimated cost budget', () => {
      const explainJson = {
        Plan: {
          'Node Type': 'Index Scan',
          'Relation Name': 'User',
          'Startup Cost': 0.42,
          'Total Cost': 120.5,
          'Plan Rows': 50,
          'Plan Width': 64,
        },
      };

      const analysis = service.parseExplainJson(explainJson, 'SELECT * FROM "User"');

      expect(analysis.passed).toBe(true);
      expect(analysis.totalCost).toBe(120.5);
      expect(analysis.costExceeded).toBe(false);
      expect(analysis.diagnostics).toContain('WITHIN BUDGET');

      expect(() => service.enforceGuardrails(analysis)).not.toThrow();
    });

    it('should reject queries with estimated cost > 5,000 and throw SlowQueryCostExceededError', () => {
      const explainJson = {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'RepositoryComplexity',
          'Startup Cost': 0.0,
          'Total Cost': 7850.0,
          'Plan Rows': 2500,
          'Plan Width': 128,
        },
      };

      const analysis = service.parseExplainJson(
        explainJson,
        'SELECT * FROM "RepositoryComplexity"',
        'RepositoryComplexity',
      );

      expect(analysis.passed).toBe(false);
      expect(analysis.totalCost).toBe(7850.0);
      expect(analysis.costExceeded).toBe(true);
      expect(analysis.diagnostics).toContain('EXCEEDS THRESHOLD');

      expect(() => service.enforceGuardrails(analysis)).toThrow(SlowQueryCostExceededError);
      expect(() => service.enforceGuardrails(analysis)).toThrow(
        /Estimated total cost 7850 exceeds maximum threshold of 5000/i,
      );
    });
  });

  describe('Sequential Scan & Missing Index Alerts on Large Tables (> 10,000 rows)', () => {
    it('should detect sequential scan on large tables and throw UnindexedSequentialScanError with missing composite index advice', () => {
      const explainJson = {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'DeveloperRating',
          'Startup Cost': 0.0,
          'Total Cost': 4500.0, // within 5000 budget, but large seq scan
          'Plan Rows': 150000, // exceeds 10,000 large table threshold
          'Plan Width': 32,
          Filter: '(xp > 1000) AND (elo < 2000)',
        },
      };

      const analysis = service.parseExplainJson(
        explainJson,
        'SELECT * FROM "DeveloperRating" WHERE xp > 1000 AND elo < 2000',
        'DeveloperRating',
        ['xp', 'elo'],
      );

      expect(analysis.isSequentialScan).toBe(true);
      expect(analysis.hasLargeTableSeqScan).toBe(true);
      expect(analysis.missingIndexAdvice).toBe('Missing composite index on [xp, elo]');
      expect(analysis.diagnostics).toContain('Missing composite index on [xp, elo]');

      expect(() => service.enforceGuardrails(analysis)).toThrow(UnindexedSequentialScanError);
      expect(() => service.enforceGuardrails(analysis)).toThrow(
        /Unindexed query detected on table DeveloperRating. Estimated 150000 rows scanned sequentially/i,
      );
      expect(() => service.enforceGuardrails(analysis)).toThrow(
        /Missing composite index on \[xp, elo\]/i,
      );
    });

    it('should allow sequential scans on small reference tables (< 10,000 rows)', () => {
      const explainJson = {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'Achievement',
          'Startup Cost': 0.0,
          'Total Cost': 25.0,
          'Plan Rows': 80,
          'Plan Width': 24,
        },
      };

      const analysis = service.parseExplainJson(
        explainJson,
        'SELECT * FROM "Achievement"',
        'Achievement',
      );

      expect(analysis.isSequentialScan).toBe(true);
      expect(analysis.hasLargeTableSeqScan).toBe(false);
      expect(analysis.costExceeded).toBe(false);
      expect(analysis.passed).toBe(true);

      expect(() => service.enforceGuardrails(analysis)).not.toThrow();
    });
  });

  describe('Nested Plan Tree Traversal', () => {
    it('should recursively detect sequential scans in nested join plans', () => {
      const nestedExplainJson = {
        Plan: {
          'Node Type': 'Nested Loop',
          'Startup Cost': 0.42,
          'Total Cost': 6200.0,
          'Plan Rows': 500,
          'Plan Width': 128,
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'User',
              'Startup Cost': 0.42,
              'Total Cost': 8.5,
              'Plan Rows': 1,
              'Plan Width': 64,
            },
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'DeveloperRating',
              'Startup Cost': 0.0,
              'Total Cost': 6190.0,
              'Plan Rows': 25000,
              'Plan Width': 64,
              Filter: '(userId = "User".id)',
            },
          ],
        },
      };

      const analysis = service.parseExplainJson(
        nestedExplainJson,
        'SELECT * FROM "User" JOIN "DeveloperRating" ...',
        'DeveloperRating',
      );

      expect(analysis.scanTypes).toContain('Nested Loop');
      expect(analysis.scanTypes).toContain('Index Scan');
      expect(analysis.scanTypes).toContain('Seq Scan');
      expect(analysis.isSequentialScan).toBe(true);
      expect(analysis.hasLargeTableSeqScan).toBe(true);
      expect(analysis.costExceeded).toBe(true);
    });
  });

  describe('Heuristic Interception', () => {
    it('should catch unindexed DeveloperRating query in heuristic mode', async () => {
      await expect(
        service.interceptFindMany('DeveloperRating', {
          where: { xp: 500, elo: 1200 },
        }),
      ).rejects.toThrow(UnindexedSequentialScanError);
    });

    it('should pass indexed queries in heuristic mode', async () => {
      const analysis = await service.interceptFindMany('User', {
        where: { id: 'usr-123' },
      });

      expect(analysis.passed).toBe(true);
      expect(analysis.costExceeded).toBe(false);
    });
  });
});

