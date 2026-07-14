import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../system-users/dto/paginated-system-users-response.dto';
import { LineUserResponseDto } from './line-user-response.dto';

/**
 * The `{ data, meta }` envelope for `GET /line-users`, paralleling
 * `PaginatedSystemUsersResponseDto`.
 *
 * `PaginationMetaDto` is imported from the system-users DTO so the OpenAPI spec has ONE shared
 * `PaginationMetaDto` schema for both collections — never a duplicated `PaginationMetaDto1` in the
 * generated frontend types.
 */
export class PaginatedLineUsersResponseDto {
  @ApiProperty({ type: [LineUserResponseDto] })
  data!: LineUserResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}
