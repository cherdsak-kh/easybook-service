import { ApiProperty } from '@nestjs/swagger';
import { RichMenuType } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateUserRichMenuDto {
  @ApiProperty({ enum: RichMenuType, example: RichMenuType.TYPE_2 })
  @IsEnum(RichMenuType)
  richMenuType!: RichMenuType;
}
