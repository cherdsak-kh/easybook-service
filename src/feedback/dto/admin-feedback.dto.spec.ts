import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { FeedbackStatus } from '@prisma/client';
import { ListFeedbackQueryDto } from './admin-feedback-query.dto';
import { UpdateFeedbackDto } from './admin-feedback-write.dto';

/** The exact global pipe from `app.setup.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const run = <T>(
  metatype: new () => T,
  type: ArgumentMetadata['type'],
  value: unknown,
): Promise<T> => pipe.transform(value, { type, metatype }) as Promise<T>;

const body = (value: unknown) => run(UpdateFeedbackDto, 'body', value);
const query = (value: Record<string, string>) =>
  run(ListFeedbackQueryDto, 'query', value);

/** Resolves to the pipe's `message[]` on a refusal, or throws if it accepted. */
const refusal = async (p: Promise<unknown>): Promise<string[]> => {
  try {
    await p;
  } catch (e) {
    const response = (e as { response?: { message?: string[] } }).response;
    if (!response?.message) throw e;
    return response.message;
  }
  throw new Error('expected a ValidationPipe rejection');
};

describe('UpdateFeedbackDto (through the global ValidationPipe)', () => {
  it.each([
    FeedbackStatus.PENDING,
    FeedbackStatus.IN_PROGRESS,
    FeedbackStatus.RESOLVED,
  ])('accepts status %s', async (status) => {
    await expect(body({ status })).resolves.toMatchObject({ status });
  });

  it('refuses DISMISSED — the prototype draws no such state (OQ-1, AC-15)', async () => {
    const messages = await refusal(body({ status: FeedbackStatus.DISMISSED }));
    expect(messages.join(' ')).toContain('status');
  });

  it('refuses an explicit null status rather than reading it as absent', async () => {
    await refusal(body({ status: null }));
  });

  it('refuses an explicit null or non-string note', async () => {
    await refusal(body({ note: null }));
    await refusal(body({ note: 42 }));
  });

  it('trims the note, and counts AFTER trimming: 500 ok, 501 refused (E-9)', async () => {
    const ok = await body({ note: `  ${'ก'.repeat(500)}  ` });
    expect(ok.note).toBe('ก'.repeat(500));

    const messages = await refusal(body({ note: `  ${'ก'.repeat(501)}  ` }));
    expect(messages.join(' ')).toContain('note');
  });

  it('turns a whitespace-only note into undefined — blank is exactly absent (AC-15)', async () => {
    const dto = await body({ note: '   \n\t ' });
    expect(dto.note).toBeUndefined();
  });

  it('lets an empty body through the pipe — the SERVICE refuses it with one string (C-3)', async () => {
    const dto = await body({});
    expect(dto.status).toBeUndefined();
    expect(dto.note).toBeUndefined();
  });

  it.each([
    ['authorId', 'clx_attacker'],
    ['feedbackId', 'clx_other'],
    ['createdAt', '2026-09-21T00:00:00.000Z'],
  ])('refuses a body containing `%s` (AC-15, AC-19)', async (key, value) => {
    const messages = await refusal(body({ note: 'x', [key]: value }));
    expect(messages.join(' ')).toContain(`property ${key} should not exist`);
  });
});

describe('ListFeedbackQueryDto (through the global ValidationPipe)', () => {
  it('defaults page=1 and limit=10', async () => {
    await expect(query({})).resolves.toMatchObject({ page: 1, limit: 10 });
  });

  it.each(['10', '20', '50'])('accepts limit=%s', async (limit) => {
    await expect(query({ limit })).resolves.toMatchObject({
      limit: Number(limit),
    });
  });

  it.each(['25', '0', '100', 'abc'])(
    'refuses limit=%s — never clamped (D-4)',
    async (limit) => {
      await refusal(query({ limit }));
    },
  );

  it('refuses page=0 and an unknown key', async () => {
    await refusal(query({ page: '0' }));
    const messages = await refusal(query({ foo: '1' }));
    expect(messages.join(' ')).toContain('property foo should not exist');
  });

  it('accepts the full status enum as a FILTER, DISMISSED included (OQ-1)', async () => {
    await expect(query({ status: 'DISMISSED' })).resolves.toMatchObject({
      status: FeedbackStatus.DISMISSED,
    });
    await refusal(query({ status: 'NOPE' }));
    await refusal(query({ type: 'NOPE' }));
  });

  it('accepts venueId=general and trims q, refusing q over 100 characters', async () => {
    await expect(
      query({ venueId: 'general', q: '  #ISS  ' }),
    ).resolves.toMatchObject({ venueId: 'general', q: '#ISS' });
    await refusal(query({ q: 'x'.repeat(101) }));
  });
});
