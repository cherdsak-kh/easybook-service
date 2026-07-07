import { ApiProperty } from '@nestjs/swagger';
import { AppAccess, RichMenuType } from '@prisma/client';

/** Public view of a LINE user (source schema for the OpenAPI spec). */
export class LineUserResponseDto {
  @ApiProperty({ example: 'U0123456789abcdef0123456789abcdef' })
  lineUserId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Alice' })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pictureUrl!: string | null;

  @ApiProperty({ enum: RichMenuType, example: RichMenuType.TYPE_1 })
  richMenuType!: RichMenuType;

  @ApiProperty({ enum: AppAccess, example: AppAccess.PENDING })
  access!: AppAccess;

  @ApiProperty({ example: '2026-07-07T10:00:00.000Z' })
  followedAt!: string;
}
