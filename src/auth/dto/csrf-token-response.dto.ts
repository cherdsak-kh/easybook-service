import { ApiProperty } from '@nestjs/swagger';

export class CsrfTokenResponseDto {
  @ApiProperty({
    example: 'a3f1c0d9e8b7…',
    description:
      'Send as the `x-csrf-token` header on state-changing requests.',
  })
  csrfToken!: string;
}
