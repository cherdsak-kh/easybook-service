/**
 * `ชื่อ นามสกุล · ตำแหน่ง · กลุ่ม/ฝ่าย` — the Phase 2 D-1 data rule (design §2.5, plan B-2).
 *
 * Structural, satisfied by BOTH `LineUserRegistration` and `SystemUser` selected with
 * {@link ATTRIBUTION_SELECT} — no value import from `line/*` or `system-users/*` is needed (design
 * §2.1's file-level import rule).
 */
export interface PersonFacts {
  firstName: string;
  lastName: string;
  personnelRole?: { name: string } | null;
  department?: { name: string } | null;
}

/** Valid on both `SystemUser` and `LineUserRegistration`. */
export const ATTRIBUTION_SELECT = {
  firstName: true,
  lastName: true,
  personnelRole: { select: { name: true } },
  department: { select: { name: true } },
} as const;

/** `·` inside a part would be ambiguous with the separator, so it is replaced, never dropped. */
const cleanPart = (v: string): string =>
  v.trim().replace(/\s+/g, ' ').replace(/·/g, '-');

/**
 * `formatActor(name, position, department)` → `"ชื่อ นามสกุล · ตำแหน่ง · กลุ่ม/ฝ่าย"`.
 *
 * Each part is trimmed and whitespace-collapsed; an empty part is DROPPED WITH its separator, and
 * Position always sits before Group/Department. All-empty returns `''` — the caller supplies a
 * fallback (see {@link attributionOf}).
 */
export function formatActor(
  name: string | null | undefined,
  position: string | null | undefined,
  department: string | null | undefined,
): string {
  const parts = [name, position, department]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0)
    .map(cleanPart);
  return parts.join(' · ');
}

/** `formatActor` over a {@link PersonFacts} row, with a Thai fallback when every part is empty. */
export function attributionOf(
  p: PersonFacts | null | undefined,
  fallback = 'ไม่ระบุชื่อ',
): string {
  if (!p) return fallback;
  const name = `${p.firstName} ${p.lastName}`;
  return (
    formatActor(
      name,
      p.personnelRole?.name ?? null,
      p.department?.name ?? null,
    ) || fallback
  );
}
