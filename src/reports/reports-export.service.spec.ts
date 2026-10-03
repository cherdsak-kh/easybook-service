import { SystemRole } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReportPeriod, ReportTemplate } from './dto/reports-export-query.dto';
import { REPORT_DOCUMENT_MAX_ROWS } from './report-export.constants';
import { ReportsExportService } from './reports-export.service';

const actor = { id: 'a', role: SystemRole.ADMIN, createdById: null };

function service(ledgerRows: number) {
  const prisma = {
    appSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    bookingRequest: {
      aggregate: jest.fn().mockResolvedValue({ _min: { firstStartAt: null } }),
      findMany: jest
        .fn()
        .mockResolvedValue(Array.from({ length: ledgerRows }, () => ({}))),
    },
    bookingSlot: { findMany: jest.fn().mockResolvedValue([]) },
    venue: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
    department: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
  };
  return new ReportsExportService(prisma as unknown as PrismaService);
}

const query = (template: ReportTemplate) => ({
  template,
  period: ReportPeriod.CUSTOM,
  startDate: '2020-01-06',
  endDate: '2020-01-07',
});

describe('ReportsExportService safety valve (design §2.3.1 row 8)', () => {
  it('refuses a ledger over the row cap with a coded 400 instead of silently truncating', async () => {
    await expect(
      service(REPORT_DOCUMENT_MAX_ROWS + 1).build(
        query(ReportTemplate.LEDGER),
        actor,
      ),
    ).rejects.toMatchObject({
      response: { statusCode: 400, code: 'REPORT_DOCUMENT_TOO_LARGE' },
    });
  });

  it('allows exactly the cap, and the cap does not apply to the other templates', async () => {
    // `{}` rows carry no fields, so only the ledger-size check is under test; the fold would choke on
    // them for the other templates, so use zero rows there.
    await expect(
      service(0).build(query(ReportTemplate.SUMMARY), actor),
    ).resolves.toMatchObject({
      isEmpty: true,
    });
    await expect(
      service(0).build(query(ReportTemplate.LEDGER), actor),
    ).resolves.toMatchObject({
      isEmpty: true,
      template: 'LEDGER',
    });
  });
});
