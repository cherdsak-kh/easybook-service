import { ApiProperty } from '@nestjs/swagger';
import { SystemUserResponseDto } from './system-user-response.dto';

/** Named schema, per the `LineUserResponseDto` precedent — not an inline object. */
export class PaginationMetaDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42, description: 'Non-deleted rows only.' })
  total!: number;

  @ApiProperty({
    example: 3,
    description: 'ceil(total / limit); 0 when total is 0.',
  })
  totalPages!: number;
}

export class PaginatedSystemUsersResponseDto {
  @ApiProperty({ type: [SystemUserResponseDto] })
  data!: SystemUserResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}
