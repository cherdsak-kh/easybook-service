import { ApiProperty } from '@nestjs/swagger';
import { AppAccess, RichMenuType } from '@prisma/client';
import { LineUserRegistrationSummaryDto } from './line-user-registration-summary.dto';

/** Public view of a LINE user (source schema for the OpenAPI spec). */
export class LineUserResponseDto {
  @ApiProperty({
    example: 'clx1a2b3c4d5e6f7g8h9i0j1',
    description:
      'The LineUser.id (a cuid) — the PATCH /line-users/:id target key.',
  })
  id!: string;

  @ApiProperty({ example: 'U0123456789abcdef0123456789abcdef' })
  lineUserId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Alice' })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pictureUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Out for lunch 🍜' })
  statusMessage!: string | null;

  @ApiProperty({ enum: RichMenuType, example: RichMenuType.TYPE_1 })
  richMenuType!: RichMenuType;

  @ApiProperty({ enum: AppAccess, example: AppAccess.PENDING })
  access!: AppAccess;

  @ApiProperty({ example: '2026-07-07T10:00:00.000Z' })
  followedAt!: string;

  /**
   * When the user SUBMITTED their registration, or `null` if they never did — which is what the
   * back-office table renders as a dash under `วันที่ลงทะเบียน`.
   *
   * ⚠️ Read this and NOT `followedAt` for that column. `followedAt` is the day they added the
   * Official Account as a friend, and every follower has one; only registered people have this.
   * It is also the key the list's two date sort modes order by.
   */
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-07-09T04:30:00.000Z',
    description:
      'Registration submission date, or null for a follower who never registered. NOT followedAt.',
  })
  registeredAt!: string | null;

  @ApiProperty({
    type: LineUserRegistrationSummaryDto,
    nullable: true,
    description:
      "The user's registration summary, or null for a follower who never submitted the form.",
  })
  registration!: LineUserRegistrationSummaryDto | null;
}
