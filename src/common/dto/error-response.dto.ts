import { ApiProperty } from '@nestjs/swagger';

/** The standard Nest error envelope, exposed once as a named OpenAPI schema. */
export class ErrorResponseDto {
  @ApiProperty({ example: 401 })
  statusCode!: number;

  @ApiProperty({ example: 'Unauthorized' })
  error!: string;

  @ApiProperty({ example: 'Invalid email or password.' })
  message!: string;
}
