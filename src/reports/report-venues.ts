import { BookingStatus } from '@prisma/client';
import {
  bangkokDate,
  bangkokMinutesOfDay,
  clipToSchoolWindow,
  HOUR_MS,
  isoWeekdayOf,
  schoolWindowStartMs,
} from './report-calendar';
import { isAutoRejected, type OpenReportWindow } from './report-fold';
import { HEAT_CELL_COUNT, HEAT_SLOT_COUNT } from './reports.constants';
import type {
  ReportHeatCellDto,
  ReportVenueClashDto,
  ReportVenueRowDto,
} from './dto/reports-venues-response.dto';

/**
 * Hub 2's pure formulas (design §2.2) — the 40-cell heatmap, top clash and venue table. Nothing
 * here does I/O; `reports.service.ts` supplies already-read Prisma rows.
 */

export interface HeatCell {
  ms: number;
  segments: number;
}

function emptyHeat40(): HeatCell[] {
  return Array.from({ length: HEAT_CELL_COUNT }, () => ({
    ms: 0,
    segments: 0,
  }));
}

function cellIndexOf(isoWeekday: number, j: number): number {
  return (isoWeekday - 1) * HEAT_SLOT_COUNT + j;
}

export function toCellDtos(cells: readonly HeatCell[]): ReportHeatCellDto[] {
  return cells.map((c) => ({
    heldHours: c.ms / HOUR_MS,
    segments: c.segments,
  }));
}

/**
 * Folds held slots into the 40-cell "scope all" heatmap plus a per-venue map (D-15, AC-V9). Uses
 * `clipToSchoolWindow` — the SAME clipping function `foldHeldMs` uses — so Σ over the 40 cells of
 * `heldHours` (scope all) equals the KPI held hours exactly (design §2.1.5).
 */
export function foldHeatmap<
  S extends { venueId: string; startAt: Date; endAt: Date },
>(
  slots: readonly S[],
  w: OpenReportWindow,
): { all: HeatCell[]; byVenue: Map<string, HeatCell[]> } {
  const all = emptyHeat40();
  const byVenue = new Map<string, HeatCell[]>();

  for (const slot of slots) {
    const segments = clipToSchoolWindow(slot, w.startDate, w.effectiveEndDate);
    if (segments.length === 0) continue;
    let venueCells = byVenue.get(slot.venueId);
    if (!venueCells) {
      venueCells = emptyHeat40();
      byVenue.set(slot.venueId, venueCells);
    }
    for (const seg of segments) {
      const winStart = schoolWindowStartMs(seg.date);
      for (let j = 0; j < HEAT_SLOT_COUNT; j += 1) {
        const cellStart = winStart + j * HOUR_MS;
        const cellEnd = cellStart + HOUR_MS;
        const overlap =
          Math.min(seg.endMs, cellEnd) - Math.max(seg.startMs, cellStart);
        if (overlap <= 0) continue;
        const idx = cellIndexOf(seg.isoWeekday, j);
        all[idx].ms += overlap;
        all[idx].segments += 1;
        venueCells[idx].ms += overlap;
        venueCells[idx].segments += 1;
      }
    }
  }
  return { all, byVenue };
}

function hhmm(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60)
    .toString()
    .padStart(2, '0');
  const m = (minutesOfDay % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * The most frequent auto-reject `(weekday, first-slot start, first-slot end)` among `rows` (D-15,
 * OQ-A3: keyed on the FIRST slot only). Ties: lower weekday, then earlier start, then earlier end.
 */
export function topClashOf<
  R extends {
    status: BookingStatus;
    rejectReason: string | null;
    slots: readonly { startAt: Date; endAt: Date }[];
  },
>(rows: readonly R[]): ReportVenueClashDto | null {
  const byKey = new Map<string, ReportVenueClashDto>();
  for (const row of rows) {
    if (!isAutoRejected(row)) continue;
    const first = row.slots[0];
    if (!first) continue;
    const isoWeekday = isoWeekdayOf(bangkokDate(first.startAt));
    const startTime = hhmm(bangkokMinutesOfDay(first.startAt));
    const endTime = hhmm(bangkokMinutesOfDay(first.endAt));
    const key = `${isoWeekday}|${startTime}|${endTime}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { isoWeekday, startTime, endTime, count: 1 });
    }
  }
  let best: ReportVenueClashDto | null = null;
  for (const entry of byKey.values()) {
    if (!best || isBetterClash(entry, best)) best = entry;
  }
  return best;
}

function isBetterClash(
  a: ReportVenueClashDto,
  b: ReportVenueClashDto,
): boolean {
  if (a.count !== b.count) return a.count > b.count;
  if (a.isoWeekday !== b.isoWeekday) return a.isoWeekday < b.isoWeekday;
  if (a.startTime !== b.startTime) return a.startTime < b.startTime;
  return a.endTime < b.endTime;
}

export interface VenueRowInput {
  id: string;
  name: string;
  capacity: number;
  isOpen: boolean;
  deletedAt: Date | null;
  venueType: { name: string } | null;
}

export interface VenueRequestRowInput {
  venueId: string;
  status: BookingStatus;
  rejectReason: string | null;
  slots: readonly { startAt: Date; endAt: Date }[];
}

/**
 * The venue table (D-17): every non-deleted venue, plus deleted ones with activity, sorted
 * occupancy desc, requests desc, then name.
 */
export function buildVenueRows(
  venueRows: readonly VenueRowInput[],
  requestRows: readonly VenueRequestRowInput[],
  held: { msByVenue: Map<string, number> },
  heat: { byVenue: Map<string, HeatCell[]> },
  schoolDays: number,
): ReportVenueRowDto[] {
  const reqByVenue = new Map<string, VenueRequestRowInput[]>();
  for (const r of requestRows) {
    const list = reqByVenue.get(r.venueId);
    if (list) list.push(r);
    else reqByVenue.set(r.venueId, [r]);
  }
  const emptyCells = toCellDtos(emptyHeat40());

  const rows: ReportVenueRowDto[] = [];
  for (const v of venueRows) {
    const isDeleted = v.deletedAt !== null;
    const heldMs = held.msByVenue.get(v.id) ?? 0;
    const venueReqs = reqByVenue.get(v.id) ?? [];
    if (isDeleted && heldMs === 0 && venueReqs.length === 0) continue;

    const heldHours = heldMs / HOUR_MS;
    const occupancyPercent =
      schoolDays > 0 ? (heldHours / (schoolDays * 8)) * 100 : null;
    const requests = venueReqs.length;
    const approved = venueReqs.filter(
      (r) => r.status === BookingStatus.APPROVED,
    ).length;
    const autoRejected = venueReqs.filter(isAutoRejected).length;
    const autoRejectedPercent =
      requests > 0 ? (autoRejected / requests) * 100 : null;
    const venueCells = heat.byVenue.get(v.id);
    const cells = venueCells ? toCellDtos(venueCells) : emptyCells;
    const topClash = topClashOf(venueReqs);

    rows.push({
      venueId: v.id,
      name: v.name,
      typeName: v.venueType?.name ?? '',
      capacity: v.capacity,
      isOpen: v.isOpen,
      isDeleted,
      heldHours,
      occupancyPercent,
      requests,
      approved,
      autoRejected,
      autoRejectedPercent,
      cells,
      topClash,
    });
  }

  rows.sort(
    (a, b) =>
      (b.occupancyPercent ?? 0) - (a.occupancyPercent ?? 0) ||
      b.requests - a.requests ||
      a.name.localeCompare(b.name, 'th') ||
      a.venueId.localeCompare(b.venueId),
  );
  return rows;
}
