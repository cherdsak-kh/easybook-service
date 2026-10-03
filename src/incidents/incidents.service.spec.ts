import { Logger, NotFoundException } from '@nestjs/common';
import { IncidentStore } from './incident-store';
import { IncidentsService } from './incidents.service';
import {
  IncidentCallerKind,
  IncidentComponent,
  IncidentSeverity,
  type IncidentSummaryRecord,
} from './incident.types';
import type { RequestMetrics } from './request-metrics';

const DAY = 86_400_000;
const NOW = new Date('2026-10-03T05:00:00Z').getTime(); // 12:00 Bangkok

let seq = 0;
const rec = (
  over: Partial<IncidentSummaryRecord> = {},
): IncidentSummaryRecord => {
  seq += 1;
  return {
    id: `ERR-500-${String(seq).padStart(4, '0')}`,
    seq,
    traceId: `tr-${String(seq).padStart(16, '0')}`,
    atMs: NOW - 1000,
    severity: IncidentSeverity.ERROR,
    component: IncidentComponent.API,
    status: 500,
    method: 'GET',
    path: '/api/v1/venues/abc',
    routeTemplate: '/api/v1/venues/:id',
    message: 'boom',
    caller: { kind: IncidentCallerKind.ANONYMOUS, label: 'anonymous' },
    ip: null,
    ...over,
  };
};

function setup(rows: IncidentSummaryRecord[]) {
  const store = {
    list: jest.fn(() => Promise.resolve(rows)),
    detail: jest.fn(),
    purgeBefore: jest.fn(() => Promise.resolve(2)),
  };
  const metrics = {
    read: jest.fn(() =>
      Promise.resolve({ requests: 2000, failed: 2, daysWithoutData: 1 }),
    ),
  };
  const service = new IncidentsService(
    store as unknown as IncidentStore,
    metrics as unknown as RequestMetrics,
  );
  return { service, store, metrics };
}

describe('IncidentsService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    seq = 0;
  });
  afterEach(() => jest.useRealTimers());

  const range = { startDate: '2026-09-04', endDate: '2026-10-03' };

  describe('list', () => {
    it('filters by Bangkok day, severity, component and search; newest first; echoes retention', async () => {
      const rows = [
        rec({
          atMs: NOW - 1000,
          severity: IncidentSeverity.CRITICAL,
          component: IncidentComponent.PRISMA_DB,
          message: 'P2034 conflict',
        }),
        rec({ atMs: NOW - 2000, message: 'other' }),
        rec({ atMs: NOW - 40 * DAY, message: 'too old for the range' }),
      ];
      const { service } = setup(rows);
      const all = await service.list({ ...range });
      expect(all.total).toBe(2);
      expect(all.retention).toEqual({ maxEntries: 5000, maxDays: 90 });
      const crit = await service.list({
        ...range,
        severity: IncidentSeverity.CRITICAL,
      });
      expect(crit.items.map((i) => i.message)).toEqual(['P2034 conflict']);
      const byComp = await service.list({
        ...range,
        component: IncidentComponent.PRISMA_DB,
      });
      expect(byComp.total).toBe(1);
      const q = await service.list({ ...range, q: 'P2034' });
      expect(q.total).toBe(1);
    });

    it('treats % and _ in the search literally', async () => {
      const { service } = setup([
        rec({ message: '100% failed' }),
        rec({ message: 'plain' }),
      ]);
      expect((await service.list({ ...range, q: '%' })).total).toBe(1);
      expect((await service.list({ ...range, q: 'p_ain' })).total).toBe(0);
    });

    it('finds exactly the incident of a full trace id', async () => {
      const target = rec({ traceId: 'tr-abcdef0123456789' });
      const { service } = setup([rec(), target, rec()]);
      const out = await service.list({ ...range, q: 'tr-abcdef0123456789' });
      expect(out.items.map((i) => i.id)).toEqual([target.id]);
    });

    it('matches the "<status> <method> <path>" string', async () => {
      const { service } = setup([
        rec({ status: 502, method: 'POST', path: '/api/v1/line/x' }),
        rec(),
      ]);
      expect(
        (await service.list({ ...range, q: '502 post /api/v1/line' })).total,
      ).toBe(1);
    });

    it('includes today, and an incident at 00:00:00 +07 of the next day is out of range', async () => {
      const endOfRange = new Date('2026-10-03T16:59:59.999Z').getTime(); // 23:59:59.999 +07
      const nextDay = new Date('2026-10-03T17:00:00Z').getTime(); // 00:00:00 +07 on the 4th
      const { service } = setup([
        rec({ atMs: endOfRange }),
        rec({ atMs: nextDay }),
      ]);
      expect((await service.list({ ...range })).total).toBe(1);
    });

    it('paginates and clamps a page past the end', async () => {
      const rows = Array.from({ length: 25 }, (_, i) =>
        rec({ atMs: NOW - i * 1000 }),
      );
      const { service } = setup(rows);
      const p3 = await service.list({ ...range, page: 3, limit: 10 });
      expect(p3.items).toHaveLength(5);
      expect(p3.totalPages).toBe(3);
      const clamped = await service.list({ ...range, page: 99, limit: 10 });
      expect(clamped.page).toBe(3);
    });

    it('purgeable counts incidents older than the first day of the 30-day window', async () => {
      const cutoffDay = '2026-09-04'; // today (10-03) - 29 days
      const justBefore = new Date('2026-09-03T16:59:59Z').getTime(); // 23:59:59 +07 on 09-03
      const justAfter = new Date('2026-09-03T17:00:00Z').getTime(); // 00:00:00 +07 on 09-04
      const { service } = setup([
        rec({ atMs: justBefore }),
        rec({ atMs: justAfter }),
        rec(),
      ]);
      const out = await service.list({ ...range });
      expect(out.purgeable).toEqual({ count: 1, cutoffDate: cutoffDay });
    });

    it('400s with a stable code on a bad range', async () => {
      const { service } = setup([]);
      await expect(
        service.list({ startDate: '2026-10-03', endDate: '2026-09-01' }),
      ).rejects.toMatchObject({ response: { code: 'REPORT_RANGE_INVERTED' } });
      await expect(
        service.list({ startDate: '2025-01-01', endDate: '2026-10-03' }),
      ).rejects.toMatchObject({ response: { code: 'REPORT_RANGE_TOO_WIDE' } });
    });
  });

  describe('kpis', () => {
    it('computes availability, the rolling 24 h, critical and external counts', async () => {
      const rows = [
        rec({
          severity: IncidentSeverity.CRITICAL,
          component: IncidentComponent.PRISMA_DB,
          atMs: NOW - 1000,
        }),
        rec({
          component: IncidentComponent.LINE_OA,
          atMs: NOW - 2 * 3_600_000,
        }),
        rec({
          component: IncidentComponent.CLOUDFLARE_R2,
          atMs: NOW - 2 * DAY,
        }),
        rec({ component: IncidentComponent.REDIS, atMs: NOW - 2 * DAY }),
        rec({ atMs: NOW - 50 * DAY }), // outside the range, still counted by nothing
      ];
      const { service, metrics } = setup(rows);
      const out = await service.kpis({
        startDate: '2026-10-01',
        endDate: '2026-10-03',
      });
      expect(metrics.read).toHaveBeenCalledWith([
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
      ]);
      expect(out.kpis.availability).toEqual({
        percent: (1 - 2 / 2000) * 100,
        failed: 2,
        requests: 2000,
        daysWithoutData: 1,
        targetPercent: 99.5,
      });
      expect(out.kpis.last24h).toBe(2); // independent of the range
      expect(out.kpis.inRange).toBe(4);
      expect(out.kpis.critical.count).toBe(1);
      expect(out.kpis.critical.latestAt).toBe(
        new Date(NOW - 1000).toISOString(),
      );
      expect(out.kpis.external).toEqual({
        lineOa: 1,
        cloudflareR2: 1,
        redis: 1,
      });
    });

    it('last24h ignores the selected range entirely', async () => {
      const { service } = setup([rec({ atMs: NOW - 1000 })]);
      const out = await service.kpis({
        startDate: '2026-09-01',
        endDate: '2026-09-02',
      });
      expect(out.kpis.inRange).toBe(0);
      expect(out.kpis.last24h).toBe(1);
    });

    it('has a null availability when no request was counted, and a null critical latest', async () => {
      const { service, metrics } = setup([]);
      metrics.read.mockResolvedValueOnce({
        requests: 0,
        failed: 0,
        daysWithoutData: 3,
      });
      const out = await service.kpis({
        startDate: '2026-10-01',
        endDate: '2026-10-03',
      });
      expect(out.kpis.availability.percent).toBeNull();
      expect(out.kpis.critical).toEqual({ count: 0, latestAt: null });
    });
  });

  describe('detail', () => {
    it('404s (coded) for a malformed id without touching the store', async () => {
      const { service, store } = setup([]);
      for (const id of ['csv', 'kpis', '../x', 'ERR-500', 'err-500-0001']) {
        await expect(service.detail(id)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(service.detail(id)).rejects.toMatchObject({
          response: { statusCode: 404, code: 'INCIDENT_NOT_FOUND' },
        });
      }
      expect(store.detail).not.toHaveBeenCalled();
    });

    it('404s for an unknown id and serves the summary when only the detail was evicted', async () => {
      const summary = rec({ id: 'ERR-500-0042' });
      const { service, store } = setup([summary]);
      store.detail.mockResolvedValue(null);
      await expect(service.detail('ERR-500-0099')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const out = await service.detail('ERR-500-0042');
      expect(out.stack).toBeNull();
      expect(out.context).toEqual({});
      expect(out.id).toBe('ERR-500-0042');
    });
  });

  describe('csv', () => {
    it('writes every filtered row without stack or context, with (กรองแล้ว) when filtered', async () => {
      const { service } = setup([
        rec({
          message: '=HYPERLINK("http://x")',
          atMs: new Date('2026-10-03T03:04:05.678Z').getTime(),
        }),
        rec({ message: 'second' }),
      ]);
      const plain = await service.csv({ ...range });
      expect(plain.fileName).toBe(
        'easybook-error-log_2026-09-04_2026-10-03.csv',
      );
      expect(plain.body.startsWith('﻿')).toBe(true);
      expect(plain.body).toContain('\r\n');
      expect(plain.body).not.toContain('(กรองแล้ว)');
      expect(plain.body).toContain("'=HYPERLINK");
      expect(plain.body).toContain('10:04:05.678'); // 03:04:05.678Z = 10:04:05.678 +07
      expect(plain.body).not.toMatch(/stack|context/i);
      const filtered = await service.csv({ ...range, q: 'second' });
      expect(filtered.body).toContain('(กรองแล้ว)');
      expect(filtered.body).not.toContain('HYPERLINK');
    });
  });

  describe('purge', () => {
    it('removes everything before the first day of the 30-day window and is safe to repeat', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const { service, store } = setup([]);
      await service.purge('cm0sa');
      await service.purge('cm0sa');
      const cutoff = new Date('2026-09-03T17:00:00Z').getTime(); // 00:00 +07 on 2026-09-04
      expect(store.purgeBefore).toHaveBeenNthCalledWith(1, cutoff);
      expect(store.purgeBefore).toHaveBeenCalledTimes(2);
    });
  });
});
