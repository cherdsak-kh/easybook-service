import { ApiProperty } from '@nestjs/swagger';

/**
 * What `GET /api/v1/system/version` answers — the DEPLOYED BUILD of this service.
 *
 * ⚠️ Not the API contract version. That is the `v1` in the URL and in the Swagger
 * `DocumentBuilder`, it changes when the shape of the contract changes, and it is a different fact
 * with a different lifetime. The version page shows both halves of the product side by side, so
 * confusing them would put the wrong number under the wrong card.
 */
export class VersionResponseDto {
  @ApiProperty({
    example: '0.1.0',
    description:
      'The release train both repositories share. `0.x.y` while in development; `1.0.0` on the ' +
      'day the school starts using it.',
  })
  version!: string;

  @ApiProperty({
    example: '5b90ee4',
    description:
      'Short commit of the running build, or `unknown` when the deploy did not stamp one.',
  })
  build!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-08-12T02:00:00.000Z',
    description:
      'When this build was produced, or null when the deploy did not stamp it.',
  })
  releasedAt!: string | null;
}
