import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { toCsv } from '../common/csv.util';
import { matchesSearch } from '../common/search-text.util';
import { addDays, bangkokDate, dayStart } from '../reports/report-calendar';
import { parseReportRange } from '../reports/report-fold';
import { thaiDateShort } from '../reports/report-thai';
import { COMPONENT_LABEL } from './incident-redact';
import { IncidentStore } from './incident-store';
import {
  INCIDENT_CAP,
  INCIDENT_MAX_AGE_DAYS,
  INCIDENT_PURGE_KEEP_DAYS,
} from './incidents.constants';
import type {
  IncidentDetailDto,
  IncidentFilterDto,
  IncidentKpisResponseDto,
  IncidentListQueryDto,
  IncidentPageDto,
  IncidentRangeDto,
  IncidentSummaryDto,
} from './dto/incident.dto';
import {
  IncidentComponent,
  IncidentSeverity,
  type IncidentDetailRecord,
  type IncidentSummaryRecord,
} from './incident.types';
import { RequestMetrics } from './request-metrics';

const DAY_MS = 86_400_000;
export const AVAILABILITY_TARGET_PERCENT = 99.5;
const INCIDENT_ID_PATTERN = /^ERR-[A-Z0-9]{2,6}-\d{4,}$/;

const NOT_FOUND = {
  statusCode: 404,
  error: 'Not Found',
  message: 'Incident not found or no longer retained.',
  code: 'INCIDENT_NOT_FOUND',
} as const;

/** `HH:MM:SS.mmm` on the Bangkok clock. */
const bangkokClockMs = (atMs: number): string =>
  new Date(atMs + 7 * 3_600_000).toISOString().slice(11, 23);

const toSummaryDto = (r: IncidentSummaryRecord): IncidentSummaryDto => ({
  id: r.id,
  traceId: r.traceId,
  at: new Date(r.atMs).toISOString(),
  severity: r.severity,
  component: r.component,
  status: r.status,
  method: r.method,
  path: r.path,
  routeTemplate: r.routeTemplate,
  message: r.message,
  caller: r.caller,
  ip: r.ip,
});

interface Window {
  range: IncidentRangeDto;
  fromMs: number;
  toMs: number;
}

/**
 * Hub 6's read side (SUPER_ADMIN only). Everything is computed over `store.list()` in memory: at the
 * 5,000-entry cap that is a few MB, and in-memory matching is what keeps `%` and `_` literal in the
 * search. Ranges INCLUDE today (D-16) and use Bangkok days.
 */
@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);

  constructor(
    private readonly store: IncidentStore,
    private readonly metrics: RequestMetrics,
  ) {}

  private windowOf(startDate: string, endDate: string): Window {
    const parsed = parseReportRange(startDate, endDate);
    return {
      range: {
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        days: parsed.days,
      },
      fromMs: dayStart(parsed.startDate).getTime(),
      toMs: dayStart(addDays(parsed.endDate, 1)).getTime(),
    };
  }

  private filtered(
    all: readonly IncidentSummaryRecord[],
    w: Window,
    f: Pick<IncidentFilterDto, 'severity' | 'component' | 'q'>,
  ): IncidentSummaryRecord[] {
    return all.filter((r) => {
      if (r.atMs < w.fromMs || r.atMs >= w.toMs) return false;
      if (f.severity !== undefined && r.severity !== f.severity) return false;
      if (f.component !== undefined && r.component !== f.component) {
        return false;
      }
      if (f.q !== undefined && f.q.trim() !== '') {
        return matchesSearch(f.q, [
          r.id,
          r.traceId,
          `${r.status ?? ''} ${r.method ?? ''} ${r.path ?? ''}`,
          r.message,
          COMPONENT_LABEL[r.component],
        ]);
      }
      return true;
    });
  }

  /** The first Bangkok day of the 30 วันล่าสุด window; anything older is purgeable. */
  private purgeCutoff(now: Date): { date: string; ms: number } {
    const date = addDays(bangkokDate(now), -(INCIDENT_PURGE_KEEP_DAYS - 1));
    return { date, ms: dayStart(date).getTime() };
  }

  async list(query: IncidentListQueryDto): Promise<IncidentPageDto> {
    const w = this.windowOf(query.startDate, query.endDate);
    const serverTime = new Date();
    const all = await this.store.list(serverTime.getTime());
    const rows = this.filtered(all, w, query);
    const limit = query.limit ?? 10;
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(Math.max(1, query.page ?? 1), totalPages);
    const cutoff = this.purgeCutoff(serverTime);
    return {
      serverTime,
      range: w.range,
      retention: { maxEntries: INCIDENT_CAP, maxDays: INCIDENT_MAX_AGE_DAYS },
      purgeable: {
        count: all.filter((r) => r.atMs < cutoff.ms).length,
        cutoffDate: cutoff.date,
      },
      items: rows.slice((page - 1) * limit, page * limit).map(toSummaryDto),
      page,
      limit,
      total,
      totalPages,
    };
  }

  async kpis(
    query: Pick<IncidentFilterDto, 'startDate' | 'endDate'>,
  ): Promise<IncidentKpisResponseDto> {
    const w = this.windowOf(query.startDate, query.endDate);
    const serverTime = new Date();
    const nowMs = serverTime.getTime();
    const days: string[] = [];
    for (let d = w.range.startDate; d <= w.range.endDate; d = addDays(d, 1)) {
      days.push(d);
    }
    const [all, counts] = await Promise.all([
      this.store.list(nowMs),
      this.metrics.read(days),
    ]);
    const inRange = this.filtered(all, w, {});
    const critical = inRange.filter(
      (r) => r.severity === IncidentSeverity.CRITICAL,
    );
    const countOf = (c: IncidentComponent) =>
      inRange.filter((r) => r.component === c).length;
    return {
      serverTime,
      range: w.range,
      kpis: {
        availability: {
          percent:
            counts.requests > 0
              ? (1 - counts.failed / counts.requests) * 100
              : null,
          failed: counts.failed,
          requests: counts.requests,
          daysWithoutData: counts.daysWithoutData,
          targetPercent: AVAILABILITY_TARGET_PERCENT,
        },
        last24h: all.filter((r) => r.atMs >= nowMs - DAY_MS).length,
        inRange: inRange.length,
        critical: {
          count: critical.length,
          latestAt:
            critical.length > 0
              ? new Date(Math.max(...critical.map((r) => r.atMs))).toISOString()
              : null,
        },
        external: {
          lineOa: countOf(IncidentComponent.LINE_OA),
          cloudflareR2: countOf(IncidentComponent.CLOUDFLARE_R2),
          redis: countOf(IncidentComponent.REDIS),
        },
      },
    };
  }

  /** 404 (coded) for an unknown, malformed or evicted id alike. */
  async detail(id: string): Promise<IncidentDetailDto> {
    if (!INCIDENT_ID_PATTERN.test(id)) throw new NotFoundException(NOT_FOUND);
    const record = await this.store.detail(id);
    if (record) return this.toDetailDto(record);
    // The detail hash may have been evicted while the ring entry survives: serve the summary.
    const summary = (await this.store.list()).find((r) => r.id === id);
    if (!summary) throw new NotFoundException(NOT_FOUND);
    return {
      ...toSummaryDto(summary),
      userAgent: null,
      errorCode: null,
      queryKeys: [],
      stack: null,
      context: {},
    };
  }

  private toDetailDto(r: IncidentDetailRecord): IncidentDetailDto {
    return {
      ...toSummaryDto(r),
      userAgent: r.userAgent,
      errorCode: r.errorCode,
      queryKeys: r.queryKeys,
      stack: r.stack,
      context: r.context,
    };
  }

  /** EVERY filtered row, no stack and no context (AC-D10). */
  async csv(
    query: IncidentFilterDto,
  ): Promise<{ fileName: string; body: string }> {
    const w = this.windowOf(query.startDate, query.endDate);
    const all = await this.store.list();
    const rows = this.filtered(all, w, query);
    const filtered =
      query.severity !== undefined ||
      query.component !== undefined ||
      (query.q !== undefined && query.q.trim() !== '');
    const lines: Array<Array<string | number | null>> = [
      ['บันทึกข้อผิดพลาด'],
      [
        `ช่วงข้อมูล ${thaiDateShort(w.range.startDate)} ถึง ${thaiDateShort(w.range.endDate)}${filtered ? ' (กรองแล้ว)' : ''}`,
      ],
      [],
      [
        'รหัสเหตุการณ์',
        'วันที่',
        'เวลา',
        'ความรุนแรง',
        'บริการ / โมดูล',
        'HTTP Status',
        'Method',
        'เส้นทาง',
        'ข้อความ',
        'Trace ID',
        'IP',
        'ผู้เรียกใช้',
      ],
    ];
    for (const r of rows) {
      lines.push([
        r.id,
        thaiDateShort(bangkokDate(new Date(r.atMs))),
        bangkokClockMs(r.atMs),
        r.severity,
        COMPONENT_LABEL[r.component],
        r.status,
        r.method,
        r.path,
        r.message,
        r.traceId,
        r.ip,
        r.caller.label,
      ]);
    }
    return {
      fileName: `easybook-error-log_${w.range.startDate}_${w.range.endDate}.csv`,
      body: toCsv(lines),
    };
  }

  /** `DELETE /reports/error-log`: removes incidents older than the 30 Bangkok-day window. Idempotent. */
  async purge(actorId: string): Promise<void> {
    const cutoff = this.purgeCutoff(new Date());
    const removed = await this.store.purgeBefore(cutoff.ms);
    this.logger.log(`Incidents purged count=${removed} by=${actorId}`);
  }
}
