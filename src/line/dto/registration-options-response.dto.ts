import { ApiProperty } from '@nestjs/swagger';

/** A single selectable option (id + display name) for the registration form. */
export class OptionDto {
  @ApiProperty({ example: 'clx1a2b3c4d5e6f7g8h9i0j1' })
  id!: string;

  @ApiProperty({ example: 'Computer Science' })
  name!: string;
}

/**
 * The combined option payload for `GET /line-users/registration/options` (SC-3.1). One bearer call
 * feeds the whole registration/edit form: only NON-deleted options, each list ordered `name ASC`.
 */
export class RegistrationOptionsResponseDto {
  @ApiProperty({ type: [OptionDto] })
  departments!: OptionDto[];

  @ApiProperty({ type: [OptionDto] })
  personnelRoles!: OptionDto[];
}
