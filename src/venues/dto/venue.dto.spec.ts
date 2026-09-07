import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { CreateVenueDto, ListVenuesQueryDto } from './venue.dto';

/**
 * `ListVenuesQueryDto.q` — the search box — must be normalised with the SAME function that
 * `Venue.name` is WRITTEN through.
 *
 * ⚠️ WHAT IS BEING PROTECTED IS NOT "the transform runs". It is the SYMMETRY between the read and
 * the write path. `q` used to carry a plain `trim`, so an operator who typed `ห้องเเดง` (SARA E
 * twice — what a Thai keyboard actually produces) searched for a byte sequence that could not exist
 * in the column, because the create form had folded the very same keystrokes to `แ` on the way in.
 * Both spellings render identically, so the screen simply said the venue was not there. The
 * round-trip case below is the one that fails if anybody puts `trim` back.
 *
 * Assertions on `q` are made on the CODE-UNIT SEQUENCE via `hex()`, for the reason
 * `sanitize-thai.util.spec.ts` states at length: two Thai strings with different mark order look the
 * same in the editor, the terminal, and Jest's diff.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const QUERY_META: ArgumentMetadata = {
  type: 'query',
  metatype: ListVenuesQueryDto,
};
const BODY_META: ArgumentMetadata = { type: 'body', metatype: CreateVenueDto };

const validateQuery = (query: unknown): Promise<ListVenuesQueryDto> =>
  pipe.transform(query, QUERY_META) as Promise<ListVenuesQueryDto>;

const validateCreate = (body: unknown): Promise<CreateVenueDto> =>
  pipe.transform(body, BODY_META) as Promise<CreateVenueDto>;

const hex = (s: string): string =>
  [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join(' ');

/** Builds a string from code points, so no case depends on how this file was saved. */
const cp = (...points: number[]): string => String.fromCodePoint(...points);

const SARA_E = 0x0e40; // เ
const SARA_AE = 0x0e41; // แ
const HO_HIP = 0x0e2b; // ห
const O_ANG = 0x0e2d; // อ
const NGO_NGU = 0x0e07; // ง
const DO_DEK = 0x0e14; // ด
const MAI_THO = 0x0e49; // ้
const SARA_I = 0x0e34; // ิ
const ZWSP = 0x200b;

/** `ห้องเเดง` as a Thai keyboard produces it: SARA E twice where SARA AE belongs. */
const DOUBLE_SARA_E_NAME = cp(
  HO_HIP,
  MAI_THO,
  O_ANG,
  NGO_NGU,
  SARA_E,
  SARA_E,
  DO_DEK,
  NGO_NGU,
);

/** The same word as it is STORED: one SARA AE. */
const SARA_AE_NAME = cp(
  HO_HIP,
  MAI_THO,
  O_ANG,
  NGO_NGU,
  SARA_AE,
  DO_DEK,
  NGO_NGU,
);

describe('ListVenuesQueryDto.q — sanitised, not merely trimmed', () => {
  it('folds double SARA E to SARA AE, so the query matches what the write path stored', async () => {
    const dto = await validateQuery({ q: DOUBLE_SARA_E_NAME });
    expect(hex(dto.q!)).toBe(hex(SARA_AE_NAME));
  });

  it('produces the SAME string the create body produces from the same keystrokes (the actual contract)', async () => {
    const query = await validateQuery({ q: DOUBLE_SARA_E_NAME });
    const body = await validateCreate({
      name: DOUBLE_SARA_E_NAME,
      venueTypeId: 4,
      capacity: 900,
    });
    // Read normalisation === write normalisation. If these ever diverge, search reports a false
    // "not found" against a row that is sitting right there.
    expect(hex(query.q!)).toBe(hex(body.name));
  });

  it('still trims, and still strips the invisible characters that break an exact search', async () => {
    const dto = await validateQuery({
      q: `  ${cp(HO_HIP, ZWSP, O_ANG, NGO_NGU)}  `,
    });
    expect(hex(dto.q!)).toBe(hex(cp(HO_HIP, O_ANG, NGO_NGU)));
  });

  it('reorders a tone typed before its vowel — NFC alone does not do this', async () => {
    // บ ้ ิ  →  บ ิ ้ ; both render identically, so only the hex proves it.
    const dto = await validateQuery({ q: cp(0x0e1a, MAI_THO, SARA_I) });
    expect(hex(dto.q!)).toBe(hex(cp(0x0e1a, SARA_I, MAI_THO)));
  });

  it('leaves plain ASCII and already-correct Thai untouched (idempotent on stored values)', async () => {
    await expect(validateQuery({ q: 'Hall A' })).resolves.toMatchObject({
      q: 'Hall A',
    });
    const dto = await validateQuery({ q: SARA_AE_NAME });
    expect(hex(dto.q!)).toBe(hex(SARA_AE_NAME));
  });

  it('passes a non-string through untouched so `@IsString()` produces the 400, not the transform', async () => {
    // The sanitiser returns non-strings as-is precisely so the validator, not the transform, owns
    // the rejection. A transform that threw here would surface as a 500.
    await expect(validateQuery({ q: 123 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(validateQuery({ q: { evil: true } })).rejects.toMatchObject({
      status: 400,
    });
    await expect(validateQuery({ q: ['a', 'b'] })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('applies @MaxLength(100) AFTER the transform', async () => {
    // 101 raw characters that the sanitiser SHORTENS to 100 — every rule shortens or preserves, so
    // the ceiling must be measured on the sanitised value or a legitimate query is refused.
    const shrinks = cp(SARA_E, SARA_E) + 'x'.repeat(99);
    expect(shrinks).toHaveLength(101);
    const dto = await validateQuery({ q: shrinks });
    expect(dto.q).toHaveLength(100);

    // And 101 characters that survive sanitising are still a 400.
    await expect(validateQuery({ q: 'x'.repeat(101) })).rejects.toMatchObject({
      status: 400,
    });
    await expect(validateQuery({ q: 'x'.repeat(100) })).resolves.toMatchObject({
      q: 'x'.repeat(100),
    });
  });

  it('is still optional — an absent q leaves the filter off', async () => {
    await expect(validateQuery({})).resolves.toMatchObject({ q: undefined });
  });
});
