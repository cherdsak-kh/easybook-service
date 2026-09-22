import { ApiProperty } from '@nestjs/swagger';

/**
 * One canned reply as the wire carries it (ANNOUNCE-API-5, D-5). Timestamps are ISO strings.
 * `GET /canned-replies` answers a PLAIN ARRAY of these (the `GET /departments` house pattern).
 */
export class CannedReplyDto {
  @ApiProperty({ example: 'canned_reply_default_1' })
  id!: string;

  @ApiProperty({ example: 'แจ้งวิธีจองสถานที่' })
  title!: string;

  @ApiProperty({
    example:
      'สวัสดีค่ะ จองสถานที่ได้ที่เมนู "จองสถานที่" ด้านล่างห้องแชทนี้ เลือกสถานที่ วันและเวลา แล้วกดยืนยัน',
  })
  text!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 9999,
    example: 0,
    description:
      'Display order, ascending; ties break on `createdAt` then `id`. Duplicates are allowed.',
  })
  sortOrder!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T08:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T08:05:00.000Z',
  })
  updatedAt!: string;
}
