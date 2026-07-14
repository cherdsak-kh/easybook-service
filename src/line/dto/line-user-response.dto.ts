import { ApiProperty } from '@nestjs/swagger';
import { AppAccess, RichMenuType } from '@prisma/client';

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
}
