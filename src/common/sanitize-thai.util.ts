/**
 * Thai text sanitiser for the transport boundary — a `@Transform` for `class-transformer`.
 *
 * ⚠️ THIS IS NOT A COLLATION PROBLEM AND NO COLLATION CAN FIX IT. Column collation decides how two
 * strings SORT; it never rewrites what was stored. Two spellings of the same Thai word — `เเก้ว`
 * (SARA E twice) and `แก้ว` (SARA AE) — are different code-point sequences, so they are different
 * strings under every collation, deterministic or not, and under every Unicode normalisation form
 * (NFC/NFD/NFKC/NFKD all leave `เเ` alone: it decomposes to nothing). The only place the two can be
 * folded together is on the way IN, which is here.
 *
 * The four spellings this repairs are what a Thai keyboard actually produces, not theoretical ones:
 * every one of them renders IDENTICALLY to the correct form on screen, so a person who typed it has
 * no way to see that they typed something else. That is what makes them expensive: the row looks
 * right in every list, and then it is unsearchable by its own name and sorts in the wrong place.
 *
 * ⚠️ ORDER IS LOAD-BEARING and `normalize('NFC')` MUST COME LAST — see the notes on each rule.
 */

/** `เ` + `เ` (SARA E twice) → `แ` (SARA AE). U+0E40 U+0E40 → U+0E41. */
const DOUBLE_SARA_E = /เเ/g;

/**
 * `ํ` + `า` (NIKHAHIT + SARA AA) → `ำ` (SARA AM). U+0E4D U+0E32 → U+0E33.
 *
 * ⚠️ RUNS BEFORE {@link SARA_AM_BEFORE_TONE} on purpose: `จ` `ํ` `า` `้` only becomes a candidate for
 * the tone-order rule once this rule has produced the `ำ` that rule matches on.
 */
const NIKHAHIT_SARA_AA = /ํา/g;

/**
 * A tone mark typed BEFORE its vowel → vowel first, then the tone. `บ` `้` `ิ` → `บ` `ิ` `้`.
 *
 * Left class  = U+0E48..U+0E4C (MAI EK, MAI THO, MAI TRI, MAI CHATTAWA, THANTHAKHAT).
 * Right class = U+0E31 (MAI HAN-AKAT), U+0E34..U+0E39 (SARA I..SARA UU), U+0E47 (MAI TAIKHU).
 *
 * ⚠️ NFC IS NOT A SUBSTITUTE FOR THIS RULE, measured rather than assumed. Canonical ordering only
 * reorders marks that BOTH carry a non-zero combining class. SARA U/SARA UU (U+0E38/U+0E39) are
 * ccc=103 and the tones are ccc=107, so NFC alone already fixes `ค` `่` `ุ`. But MAI HAN-AKAT,
 * SARA I..SARA UEE and MAI TAIKHU are all **ccc=0** — starters — so NFC leaves `บ` `้` `ิ` exactly
 * as it found it. Probed: `0e1a 0e49 0e34`.normalize('NFC') === `0e1a 0e49 0e34`.
 */
const TONE_BEFORE_VOWEL = /([่-์])([ัิ-ู็])/g;

/**
 * `ำ` (SARA AM) typed BEFORE its tone → tone first. `น` `ำ` `้` → `น` `้` `ำ`, i.e. `น้ำ`, which is
 * the canonical spelling of the word for water. U+0E33 is a spacing letter (ccc=0), so — again — NFC
 * cannot do this: probed, `0e19 0e33 0e49`.normalize('NFC') is unchanged.
 */
const SARA_AM_BEFORE_TONE = /ำ([่-๋])/g;

/**
 * ZWSP, ZWNJ, ZWJ and the BOM. Invisible, and each one breaks an exact-name search silently.
 *
 * ⚠️ THESE TWO PATTERNS ARE WRITTEN AS ESCAPES, NEVER AS THE CHARACTERS THEMSELVES. A regex built
 * from literal zero-width code points is unreadable, un-reviewable and impossible to grep for — and
 * `no-irregular-whitespace` rejects it outright, which is how the first draft of this line was
 * caught. The Thai patterns above are deliberately NOT escaped: those characters have visible
 * glyphs, so the literal form is the readable one, and lint has no objection to them.
 */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/** NBSP → ordinary space, so a pasted name still matches one that was typed. */
const NBSP = /\u00A0/g;

/**
 * Normalises Thai text typed on a Thai keyboard. **Non-strings are returned untouched**, which is
 * what lets this sit on a `@Transform` in front of `@IsString()`: a `null`, a number or an object
 * must reach the validator unchanged so it produces the 400 it is there to produce, rather than
 * being coerced into a string by the sanitiser and passing.
 *
 * ### Every rule shortens or preserves length — never lengthens
 * `เเ`→`แ` and `ํา`→`ำ` are 2→1; the two reorder rules are 2→2; the strips are n→0 and 1→1; `trim`
 * only removes. So `@Transform` running BEFORE `@MaxLength` can never make a field newly overflow —
 * a string that passed `@MaxLength(120)` before sanitising still passes after.
 *
 * ### One pass, not a fixed point — and `normalize('NFC')` is what makes it idempotent
 * Each rule is a single global `replace`, so it consumes ADJACENT pairs left to right and does not
 * re-scan its own output. On odd/degenerate input that means:
 *
 * - `เเเ` (three SARA E) → `แเ`: the first pair folds, the leftover single `เ` is a legitimate
 *   spelling and is left alone. `เเเเ` → `แแ`. Sanitising `แเ` again changes nothing.
 * - Two tones stacked before one vowel — `ค` `่` `้` `ุ` — is the one input where a single pass of
 *   {@link TONE_BEFORE_VOWEL} does NOT reach the answer: it yields `ค` `่` `ุ` `้`, and a second
 *   pass would yield `ค` `ุ` `่` `้`. **`normalize('NFC')` closes that gap**, because ccc=103
 *   (SARA U) sorts ahead of ccc=107 (the tones) under canonical ordering. Measured, both ways:
 *   rules-only is NOT idempotent on that input (`e04 e48 e38 e49` → `e04 e38 e48 e49`), and
 *   rules-then-NFC IS (`e04 e38 e48 e49` both times).
 *
 * So NFC is not decoration and it is not redundant with the reorder rules: it is the step that makes
 * `sanitizeThaiText(sanitizeThaiText(x)) === sanitizeThaiText(x)` true. It must stay LAST — it is
 * the settling step, and it was verified not to undo any of the four rules above (checked on the
 * exact code-unit sequence, not on visual equality: two Thai strings with different mark order look
 * the same in every editor and terminal).
 */
export function sanitizeThaiText({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;

  return value
    .replace(DOUBLE_SARA_E, 'แ')
    .replace(NIKHAHIT_SARA_AA, 'ำ')
    .replace(TONE_BEFORE_VOWEL, '$2$1')
    .replace(SARA_AM_BEFORE_TONE, '$1ำ')
    .replace(ZERO_WIDTH, '')
    .replace(NBSP, ' ')
    .normalize('NFC')
    .trim();
}
