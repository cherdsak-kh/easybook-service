import { ApiProperty } from '@nestjs/swagger';

/** `chatMode` values, published under their own schema name. */
export const LINE_BOT_CHAT_MODES = ['chat', 'bot'] as const;

/**
 * `GET /announcements/line-bot-info` (`ANNOUNCE-API-2`, D-G) — the LINE Official Account an
 * announcement is sent from. Four fields and no more: `userId`, `premiumId` and `markAsReadMode`
 * are not exposed.
 */
export class LineBotInfoDto {
  @ApiProperty({
    example: '@123abcde',
    description: 'The OA’s basic id, `@` included.',
  })
  basicId!: string;

  @ApiProperty({ example: 'EasyBook' })
  displayName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://profile.line-scdn.net/abcdefghijklmn',
    description: 'null when the OA has no profile picture.',
  })
  pictureUrl!: string | null;

  @ApiProperty({
    enum: LINE_BOT_CHAT_MODES,
    enumName: 'LineBotChatMode',
    description:
      '`chat` — chat is on in the LINE Official Account Manager; `bot` — the OA answers by bot only.',
  })
  chatMode!: (typeof LINE_BOT_CHAT_MODES)[number];
}
