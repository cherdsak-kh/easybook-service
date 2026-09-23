import { ForbiddenException } from '@nestjs/common';
import { AppAccess } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FEEDBACK_NOT_ALLOWED } from './feedback.constants';

/**
 * 🔴 THE ONE PLACE A LINE `U…` SUBJECT BECOMES A CUID IN THIS MODULE (AC-34).
 *
 * `LineIdTokenGuard` sets `req.lineUserId = identity.sub` — the LINE-side `U…` subject, which
 * matches `LineUser.lineUserId`, NOT `LineUser.id`. `Feedback.lineUserId` is the cuid. Writing the
 * sub into that column type-checks perfectly and produces a foreign-key violation or, worse on a
 * read, a `where` that matches nothing forever. Same-name footgun as `SystemUser.lineUserId`.
 *
 * ⚠️ A FREE FUNCTION OVER THE CALLER'S CLIENT, not a private method, because this module has TWO
 * entry points — `FeedbackService.create` and `FeedbackPhotoService.upload` — and the design's
 * invariant is that the translation happens in exactly ONE place. The repo's precedent for a shared
 * rule shaped like this is `booking-overlap.ts` / `booking-code.ts`: pure modules taking the
 * caller's client, so there is no instance to substitute and no way for one caller to get a
 * different rule from the other.
 *
 * It is a copy of `BookingsService.resolveAllowedRequester` in shape and intent rather than an
 * import of it: that one is private, and the six lines of query here carry a module-owned message
 * (`feedback.constants.ts`' header states the house rule about not importing another module's
 * user-facing strings).
 *
 * A soft-deleted (unfollowed) user is treated as ABSENT — the same 403, no existence oracle. This
 * is also AC-35: only `ALLOWED` may submit, and `UNREGISTERED` / `PENDING` / `REJECTED` / `BLOCKED`
 * all get one identical refusal.
 */
export async function resolveAllowedReporter(
  prisma: PrismaService,
  lineSub: string,
): Promise<{ id: string }> {
  const user = await prisma.lineUser.findFirst({
    where: { lineUserId: lineSub, deletedAt: null },
    select: { id: true, access: true },
  });
  if (!user || user.access !== AppAccess.ALLOWED) {
    throw new ForbiddenException(FEEDBACK_NOT_ALLOWED);
  }
  return { id: user.id };
}
