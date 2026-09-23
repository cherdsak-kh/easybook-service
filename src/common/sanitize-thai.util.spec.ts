import { sanitizeThaiText } from './sanitize-thai.util';

/**
 * ⚠️ EVERY ASSERTION IN THIS FILE IS ON THE CODE-UNIT SEQUENCE, not on a Thai string literal.
 *
 * Two Thai strings whose combining marks are in a different order render IDENTICALLY — in the
 * editor, in the terminal, and in Jest's diff output. `expect(s).toBe('บ้าน')` would therefore pass
 * for a string the sanitiser never actually fixed, and the whole point of the reorder rules is the
 * order. `hex()` is what makes a wrong answer visible.
 */
const hex = (s: string): string =>
  [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join(' ');

/** Builds a string from code points, so no test input depends on how this file was saved. */
const cp = (...points: number[]): string => String.fromCodePoint(...points);

const sanitize = (value: unknown): unknown => sanitizeThaiText({ value });
/** Narrowed helper: every string case wants a string back. */
const clean = (value: string): string => sanitize(value) as string;

// --- The characters under test, named. -------------------------------------------------------
const SARA_E = 0x0e40; // เ
const SARA_AE = 0x0e41; // แ
const SARA_AA = 0x0e32; // า
const SARA_AM = 0x0e33; // ำ
const NIKHAHIT = 0x0e4d; // ํ
const MAI_HAN_AKAT = 0x0e31; // ั
const SARA_I = 0x0e34; // ิ
const SARA_II = 0x0e35; // ี
const SARA_UE = 0x0e36; // ึ
const SARA_UEE = 0x0e37; // ื
const SARA_U = 0x0e38; // ุ
const SARA_UU = 0x0e39; // ู
const MAI_TAIKHU = 0x0e47; // ็
const MAI_EK = 0x0e48; // ่
const MAI_THO = 0x0e49; // ้
const MAI_TRI = 0x0e4a; // ๊
const MAI_CHATTAWA = 0x0e4b; // ๋
const THANTHAKHAT = 0x0e4c; // ์

const KO_KAI = 0x0e01; // ก
const KHO_KHWAI = 0x0e04; // ค
const NO_NU = 0x0e19; // น
const BO_BAIMAI = 0x0e1a; // บ
const NGO_NGU = 0x0e07; // ง
const CHO_CHAN = 0x0e08; // จ
const PO_PLA = 0x0e1b; // ป
const THO_THAHAN = 0x0e17; // ท

const ZWSP = 0x200b;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const BOM = 0xfeff;
const NBSP = 0x00a0;

describe('sanitizeThaiText', () => {
  describe('non-string passthrough', () => {
    // The sanitiser sits in front of `@IsString()`. If it coerced, a `null` on a NOT NULL column
    // would become '' and reach the database instead of producing the 400 the DTO promises.
    it.each([
      ['number', 42],
      ['zero', 0],
      ['null', null],
      ['undefined', undefined],
      ['boolean', false],
      ['array', [1, 2]],
    ])('returns a %s unchanged', (_label, value) => {
      expect(sanitize(value)).toBe(value);
    });

    it('returns an object by reference, not a copy', () => {
      const value = { name: 'x' };
      expect(sanitize(value)).toBe(value);
    });
  });

  describe('rule 1 — double SARA E → SARA AE', () => {
    it('folds เ+เ into แ', () => {
      // เเก้ว  ->  แก้ว
      const input = cp(SARA_E, SARA_E, KO_KAI, MAI_THO, 0x0e27);
      expect(hex(clean(input))).toBe(hex(cp(SARA_AE, KO_KAI, MAI_THO, 0x0e27)));
    });

    it('leaves a legitimate single เ alone', () => {
      const input = cp(SARA_E, KO_KAI, MAI_EK, NGO_NGU); // เก่ง
      expect(hex(clean(input))).toBe(hex(input));
    });

    /**
     * DOCUMENTED DEGENERATE BEHAVIOUR: one global `replace` consumes ADJACENT pairs left to right
     * and does not re-scan. Three SARA E therefore become แ + a leftover เ, which is itself a valid
     * spelling — the alternative (looping to a fixed point) would silently rewrite `แเ`, a sequence
     * nobody typed by accident, into `แ`.
     */
    it('folds pairs left to right and leaves an odd leftover (เเเ → แเ)', () => {
      expect(hex(clean(cp(SARA_E, SARA_E, SARA_E, KO_KAI)))).toBe(
        hex(cp(SARA_AE, SARA_E, KO_KAI)),
      );
    });

    it('folds two full pairs (เเเเ → แแ)', () => {
      expect(hex(clean(cp(SARA_E, SARA_E, SARA_E, SARA_E, KO_KAI)))).toBe(
        hex(cp(SARA_AE, SARA_AE, KO_KAI)),
      );
    });
  });

  describe('rule 2 — NIKHAHIT + SARA AA → SARA AM', () => {
    it('folds ํ+า into ำ', () => {
      // จําปา -> จำปา
      const input = cp(CHO_CHAN, NIKHAHIT, SARA_AA, PO_PLA, SARA_AA);
      expect(hex(clean(input))).toBe(
        hex(cp(CHO_CHAN, SARA_AM, PO_PLA, SARA_AA)),
      );
    });

    it('leaves a bare SARA AA alone', () => {
      const input = cp(BO_BAIMAI, MAI_THO, SARA_AA, NO_NU); // บ้าน
      expect(hex(clean(input))).toBe(hex(input));
    });

    /** Rule 2 must run BEFORE rule 4, or the tone stays on the wrong side of the ำ it just made. */
    it('feeds rule 4: จ+ํ+า+้ becomes จ+้+ำ', () => {
      expect(hex(clean(cp(CHO_CHAN, NIKHAHIT, SARA_AA, MAI_THO)))).toBe(
        hex(cp(CHO_CHAN, MAI_THO, SARA_AM)),
      );
    });
  });

  describe('rule 3 — tone mark typed before its vowel', () => {
    // The ccc=0 vowels. NFC cannot reorder these (they are starters), so the rule is the only fix.
    it.each([
      ['MAI HAN-AKAT', MAI_HAN_AKAT],
      ['SARA I', SARA_I],
      ['SARA II', SARA_II],
      ['SARA UE', SARA_UE],
      ['SARA UEE', SARA_UEE],
      ['MAI TAIKHU', MAI_TAIKHU],
    ])('swaps a tone that precedes %s', (_label, vowel) => {
      expect(hex(clean(cp(BO_BAIMAI, MAI_THO, vowel, NO_NU)))).toBe(
        hex(cp(BO_BAIMAI, vowel, MAI_THO, NO_NU)),
      );
    });

    // The ccc=103 vowels. NFC would also fix these; the rule gets there first and agrees with it.
    it.each([
      ['SARA U', SARA_U],
      ['SARA UU', SARA_UU],
    ])('swaps a tone that precedes %s', (_label, vowel) => {
      expect(hex(clean(cp(KHO_KHWAI, MAI_EK, vowel)))).toBe(
        hex(cp(KHO_KHWAI, vowel, MAI_EK)),
      );
    });

    it.each([
      ['MAI EK', MAI_EK],
      ['MAI THO', MAI_THO],
      ['MAI TRI', MAI_TRI],
      ['MAI CHATTAWA', MAI_CHATTAWA],
      ['THANTHAKHAT', THANTHAKHAT],
    ])('swaps %s specifically', (_label, tone) => {
      expect(hex(clean(cp(BO_BAIMAI, tone, SARA_I)))).toBe(
        hex(cp(BO_BAIMAI, SARA_I, tone)),
      );
    });

    it('leaves an already-correct vowel+tone sequence alone', () => {
      const input = cp(BO_BAIMAI, SARA_I, MAI_THO, NO_NU);
      expect(hex(clean(input))).toBe(hex(input));
    });

    /**
     * ⚠️ THE ONE INPUT A SINGLE PASS CANNOT FINISH, and the reason `.normalize('NFC')` is in the
     * chain. Rules alone yield ค+่+ุ+้; NFC then sorts ccc=103 (SARA U) ahead of ccc=107 (the
     * tones) and lands on ค+ุ+่+้, which is where a second pass of the rules would also have
     * landed. Measured, not assumed.
     */
    it('settles two stacked tones before one vowel via NFC', () => {
      expect(hex(clean(cp(KHO_KHWAI, MAI_EK, MAI_THO, SARA_U)))).toBe(
        hex(cp(KHO_KHWAI, SARA_U, MAI_EK, MAI_THO)),
      );
    });
  });

  describe('rule 4 — SARA AM typed before its tone', () => {
    it('moves the tone in front of ำ (นำ้ → น้ำ)', () => {
      expect(hex(clean(cp(NO_NU, SARA_AM, MAI_THO)))).toBe(
        hex(cp(NO_NU, MAI_THO, SARA_AM)),
      );
    });

    it.each([
      ['MAI EK', MAI_EK],
      ['MAI THO', MAI_THO],
      ['MAI TRI', MAI_TRI],
      ['MAI CHATTAWA', MAI_CHATTAWA],
    ])('moves %s', (_label, tone) => {
      expect(hex(clean(cp(NO_NU, SARA_AM, tone)))).toBe(
        hex(cp(NO_NU, tone, SARA_AM)),
      );
    });

    it('leaves an already-correct น้ำ alone', () => {
      const input = cp(NO_NU, MAI_THO, SARA_AM);
      expect(hex(clean(input))).toBe(hex(input));
    });
  });

  describe('invisible characters', () => {
    it.each([
      ['ZWSP', ZWSP],
      ['ZWNJ', ZWNJ],
      ['ZWJ', ZWJ],
      ['BOM', BOM],
    ])('strips %s', (_label, invisible) => {
      expect(hex(clean(cp(KO_KAI, invisible, NGO_NGU)))).toBe(
        hex(cp(KO_KAI, NGO_NGU)),
      );
    });

    it('replaces NBSP with an ordinary space rather than deleting it', () => {
      expect(hex(clean(cp(KO_KAI, NBSP, NGO_NGU)))).toBe(
        hex(cp(KO_KAI, 0x0020, NGO_NGU)),
      );
    });

    it('trims after stripping, so a leading BOM does not block the trim', () => {
      expect(clean(cp(BOM, 0x0020, KO_KAI, 0x0020))).toBe(cp(KO_KAI));
    });

    it('trims a name padded with NBSP on both sides', () => {
      expect(clean(cp(NBSP, KO_KAI, NGO_NGU, NBSP))).toBe(cp(KO_KAI, NGO_NGU));
    });

    it('leaves internal whitespace between two words', () => {
      expect(clean(cp(KO_KAI, 0x0020, NGO_NGU))).toBe(
        cp(KO_KAI, 0x0020, NGO_NGU),
      );
    });
  });

  describe('length', () => {
    // The @Transform runs before @MaxLength, so a rule that lengthened could push a valid field
    // over the limit. None of them can; this pins that.
    it.each<[string, string]>([
      ['double SARA E', cp(SARA_E, SARA_E, KO_KAI)],
      ['NIKHAHIT + SARA AA', cp(CHO_CHAN, NIKHAHIT, SARA_AA)],
      ['tone before vowel', cp(BO_BAIMAI, MAI_THO, SARA_I)],
      ['SARA AM before tone', cp(NO_NU, SARA_AM, MAI_THO)],
      ['zero width', cp(KO_KAI, ZWSP, NGO_NGU)],
      ['NBSP', cp(KO_KAI, NBSP, NGO_NGU)],
    ])('never grows on %s', (_label, input) => {
      expect(clean(input).length).toBeLessThanOrEqual(input.length);
    });
  });

  describe('idempotency', () => {
    const CASES: [string, string][] = [
      ['double SARA E', cp(SARA_E, SARA_E, KO_KAI, MAI_THO, 0x0e27)],
      ['triple SARA E', cp(SARA_E, SARA_E, SARA_E, KO_KAI)],
      ['NIKHAHIT + SARA AA', cp(CHO_CHAN, NIKHAHIT, SARA_AA, PO_PLA, SARA_AA)],
      ['tone before ccc=0 vowel', cp(BO_BAIMAI, MAI_THO, SARA_I, NO_NU)],
      ['tone before ccc=103 vowel', cp(KHO_KHWAI, MAI_EK, SARA_U)],
      ['two tones before one vowel', cp(KHO_KHWAI, MAI_EK, MAI_THO, SARA_U)],
      ['SARA AM before tone', cp(NO_NU, SARA_AM, MAI_THO)],
      ['padded with invisibles', cp(BOM, KO_KAI, ZWSP, NGO_NGU, NBSP)],
      ['already clean', cp(SARA_AE, KO_KAI, MAI_EK, NGO_NGU)],
      ['empty', ''],
    ];

    it.each(CASES)(
      'sanitising %s twice equals sanitising it once',
      (_label, input) => {
        const once = clean(input);
        expect(hex(clean(once))).toBe(hex(once));
      },
    );

    it('output is already NFC, so it survives a re-normalise', () => {
      for (const [, input] of CASES) {
        const once = clean(input);
        expect(hex(once.normalize('NFC'))).toBe(hex(once));
      }
    });
  });

  describe('end to end', () => {
    /**
     * A realistic Thai name as a Thai keyboard mangles it, all four faults at once plus a pasted
     * zero-width space and NBSP padding:
     *   ' ' เ เ ก ่ ง ZWSP  ' ' ท NIKHAHIT า NBSP  ->  'แก่ง ทำ'
     */
    it('repairs a name carrying every fault at once', () => {
      const typed = cp(
        NBSP,
        SARA_E,
        SARA_E,
        KO_KAI,
        MAI_EK,
        NGO_NGU,
        ZWSP,
        0x0020,
        THO_THAHAN,
        NIKHAHIT,
        SARA_AA,
        NBSP,
      );
      const expected = cp(
        SARA_AE,
        KO_KAI,
        MAI_EK,
        NGO_NGU,
        0x0020,
        THO_THAHAN,
        SARA_AM,
      );
      expect(hex(clean(typed))).toBe(hex(expected));
    });

    it('leaves a correctly typed name byte-identical', () => {
      // แก้ว ใจดี — nothing here is a candidate for any rule.
      const input = cp(
        SARA_AE,
        KO_KAI,
        MAI_THO,
        0x0e27,
        0x0020,
        0x0e43,
        CHO_CHAN,
        0x0e14,
        SARA_II,
      );
      expect(hex(clean(input))).toBe(hex(input));
    });

    it('is a no-op on ASCII', () => {
      expect(clean('Ada Lovelace')).toBe('Ada Lovelace');
    });

    it('still trims plain ASCII, matching the `trim` transform it replaces', () => {
      expect(clean('  Ada  ')).toBe('Ada');
    });

    it('turns a whitespace-only string into an empty string, so @IsNotEmpty still fires', () => {
      expect(clean(cp(0x0020, NBSP, ZWSP))).toBe('');
    });
  });
});
