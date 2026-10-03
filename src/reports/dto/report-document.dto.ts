import { ApiProperty } from '@nestjs/swagger';
import { ReportRangeDto } from './reports-overview-response.dto';
import { ReportPeriod, ReportTemplate } from './reports-export-query.dto';

export enum ReportDocAlign {
  TEXT = 'TEXT',
  NUM = 'NUM',
  CENTER = 'CENTER',
  MONO = 'MONO',
  NOWRAP = 'NOWRAP',
}

/**
 * One cell. `text` is EXACTLY what the paper prints. When `value` is non-null the `.xlsx` writes a
 * NUMERIC cell `value` with `numFmt`, chosen so Excel displays `text`. When `value` is null it writes
 * `text` as a STRING cell, never a formula, even if it begins with `=`, `+`, `-` or `@`.
 */
export class ReportDocCellDto {
  @ApiProperty()
  text!: string;

  @ApiProperty({ type: Number, nullable: true })
  value!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '#,##0" รายการ"',
  })
  numFmt!: string | null;
}

export class ReportDocColumnDto {
  @ApiProperty()
  label!: string;

  @ApiProperty({ enum: ReportDocAlign, enumName: 'ReportDocAlign' })
  align!: ReportDocAlign;
}

export class ReportDocRowDto {
  @ApiProperty({ type: [ReportDocCellDto] })
  cells!: ReportDocCellDto[];
}

export class ReportDocSectionDto {
  @ApiProperty({
    example: 'ตัวชี้วัดหลัก',
    description: 'Printed as "<n>. <title>".',
  })
  title!: string;

  @ApiProperty({ type: [ReportDocColumnDto] })
  columns!: ReportDocColumnDto[];

  @ApiProperty({ type: [ReportDocRowDto] })
  rows!: ReportDocRowDto[];

  @ApiProperty({ example: 'ไม่มีรายการในช่วงเวลาและขอบเขตที่เลือก' })
  emptyText!: string;
}

/** The six centred lines of the sheet, in order (AC-E5). */
export class ReportDocHeaderDto {
  @ApiProperty()
  title!: string;

  @ApiProperty({
    example: 'โรงเรียนเทศบาลท่าโขลง 1 สังกัดเทศบาลเมืองท่าโขลง จังหวัดปทุมธานี',
  })
  school!: string;

  @ApiProperty({ example: 'ประจำภาคเรียนที่ 1 ปีการศึกษา 2569' })
  period!: string;

  @ApiProperty({ example: '(แบบ 1 สรุปภาพรวม)' })
  kind!: string;

  @ApiProperty({
    example: 'ข้อมูลระหว่างวันที่ 16 พ.ค. 2569 ถึงวันที่ 30 ก.ย. 2569',
  })
  dateRange!: string;

  @ApiProperty({
    example: 'สำหรับขอบเขตข้อมูลสถานที่ทั้งหมด และกลุ่มสาระและฝ่ายงานทั้งหมด',
  })
  scope!: string;
}

export class ReportDocumentDto {
  @ApiProperty({ type: String, format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ type: ReportRangeDto })
  range!: ReportRangeDto;

  @ApiProperty({ enum: ReportTemplate, enumName: 'ReportTemplate' })
  template!: ReportTemplate;

  @ApiProperty({ enum: ReportPeriod, enumName: 'ReportPeriod' })
  period!: ReportPeriod;

  @ApiProperty({
    description:
      'True when the range and scope hold 0 requests and 0 held hours (D-12).',
  })
  isEmpty!: boolean;

  @ApiProperty({ type: ReportDocHeaderDto })
  header!: ReportDocHeaderDto;

  @ApiProperty({ type: [ReportDocSectionDto] })
  sections!: ReportDocSectionDto[];

  @ApiProperty({
    example: 'ข้อมูล ณ วันที่ 3 ต.ค. 2569 เอกสารออกโดยระบบ EasyBook',
  })
  footer!: string;

  @ApiProperty({
    example: 'easybook-report-summary_2026-05-16_2026-10-31.xlsx',
  })
  fileName!: string;
}

export class ReportScopeVenueDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  isDeleted!: boolean;

  @ApiProperty()
  isOpen!: boolean;
}

export class ReportScopeDepartmentDto {
  @ApiProperty()
  id!: number;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  isDeleted!: boolean;
}

export class ReportScopeOptionsDto {
  @ApiProperty({
    type: [ReportScopeVenueDto],
    description: 'Every venue, deleted ones included, sorted by Thai name.',
  })
  venues!: ReportScopeVenueDto[];

  @ApiProperty({
    type: [ReportScopeDepartmentDto],
    description:
      'Every department, deleted included. The reserved department is OMITTED for a non-SUPER_ADMIN.',
  })
  departments!: ReportScopeDepartmentDto[];
}
