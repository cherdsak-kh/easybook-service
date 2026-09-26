import { ApiProperty } from '@nestjs/swagger';
import {
  AdminNotificationCategory,
  AdminNotificationTargetRole,
  AdminNotificationTone,
} from '@prisma/client';
import { PaginationMetaDto } from '../../system-users/dto/paginated-system-users-response.dto';
import {
  ADMIN_NOTIFICATION_ICONS,
  type AdminNotificationIcon,
} from '../notifications.constants';

/**
 * Response shapes of `NOTIF-API-1` (design §3.2).
 *
 * ⚠️ SCHEMA NAMES ARE THE CLASS NAMES. None collides with an existing `/docs-json` schema (the only
 * other `*Notification*` is `NotificationPreferencesDto`). `PaginationMetaDto` is REFERENCED, never
 * redeclared — a second declaration would mint `PaginationMetaDto1` in the generated client.
 *
 * 🔴 NO SHAPE HERE CARRIES `dismissedAt`, `systemUserId`, a receipt id, or another operator's state
 * (plan §5). `isRead`/`readAt` are the CALLER's and nobody else's.
 */
export class AdminNotificationDto {
  @ApiProperty({ example: 'clx0v3n0e0000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    enum: AdminNotificationCategory,
    enumName: 'AdminNotificationCategory',
  })
  category!: AdminNotificationCategory;

  @ApiProperty({ type: String, nullable: true, example: 'BR-25690903-001' })
  code!: string | null;

  @ApiProperty({ example: 'คำขอจองใหม่ 1 รายการ' })
  title!: string;

  @ApiProperty({
    example:
      'สมชาย ใจดี · ครู · กลุ่มบริหารงานวิชาการ · ห้องประชุม 1 · 3 ก.ย. 2569 09:00–12:00',
  })
  body!: string;

  @ApiProperty({
    enum: AdminNotificationTone,
    enumName: 'AdminNotificationTone',
  })
  tone!: AdminNotificationTone;

  @ApiProperty({
    enum: [...ADMIN_NOTIFICATION_ICONS],
    enumName: 'AdminNotificationIcon',
  })
  icon!: AdminNotificationIcon;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '/backend/bookings/requests',
    description: 'Portal-relative. Non-null iff actionLabel is non-null.',
  })
  actionUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ดูคำขอจอง' })
  actionLabel!: string | null;

  @ApiProperty({
    enum: AdminNotificationTargetRole,
    enumName: 'AdminNotificationTargetRole',
    description:
      'Minimum role that sees this row: ALL ⊂ ADMIN ⊂ SUPER_ADMIN visibility.',
  })
  targetRole!: AdminNotificationTargetRole;

  @ApiProperty({
    description: 'For the CALLER only. true iff the caller has a readAt.',
  })
  isRead!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'For the CALLER only.',
  })
  readAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Not guaranteed to equal createdAt (Prisma stamps it client-side; a seed re-run moves it). Do not compare the two.',
  })
  updatedAt!: string;
}

export class PaginatedAdminNotificationsResponseDto {
  @ApiProperty({ type: [AdminNotificationDto] })
  data!: AdminNotificationDto[];

  @ApiProperty({
    type: PaginationMetaDto,
    description: '`total` is the FILTERED total.',
  })
  meta!: PaginationMetaDto;
}

/** Unread counts for the CALLER over everything visible to them. Unaffected by any E-1 filter. */
export class AdminNotificationUnreadByCategoryDto {
  @ApiProperty({ example: 2 })
  BOOKING!: number;

  @ApiProperty({ example: 1 })
  REGISTRATION!: number;

  @ApiProperty({ example: 0 })
  FEEDBACK!: number;

  @ApiProperty({ example: 1 })
  SYSTEM!: number;
}

export class AdminNotificationUnreadCountDto {
  @ApiProperty({ example: 4, description: 'Equals the sum of byCategory.' })
  total!: number;

  @ApiProperty({ type: AdminNotificationUnreadByCategoryDto })
  byCategory!: AdminNotificationUnreadByCategoryDto;
}

export class AdminNotificationsUpdatedDto {
  @ApiProperty({
    example: 3,
    description:
      'Rows whose state actually changed. Invisible or already-read ids are not counted.',
  })
  updated!: number;
}

/** The key is `deleted` (plan + prototype toast); the schema NAME says "Dismissed" so the contract does not claim a hard delete. */
export class AdminNotificationsDismissedDto {
  @ApiProperty({
    example: 3,
    description:
      'Rows actually dismissed for the caller. Invisible or already-dismissed ids are not counted.',
  })
  deleted!: number;
}
