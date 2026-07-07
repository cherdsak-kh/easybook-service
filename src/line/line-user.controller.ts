import {
  BadGatewayException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Patch,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { LineUserResponseDto } from './dto/line-user-response.dto';
import { UpdateUserRichMenuDto } from './dto/update-user-rich-menu.dto';
import { LineUserService } from './line-user.service';

/** Admin operations on LINE users. NOTE: unauthenticated for now (see backlog). */
@ApiTags('LINE Users')
@Controller('line/users')
export class LineUserController {
  constructor(private readonly users: LineUserService) {}

  /** Set a user's rich menu type in the DB AND apply it on LINE. */
  @Patch(':lineUserId/rich-menu')
  @ApiOkResponse({ description: 'Updated user.', type: LineUserResponseDto })
  async updateRichMenu(
    @Param('lineUserId') lineUserId: string,
    @Body() dto: UpdateUserRichMenuDto,
  ): Promise<LineUserResponseDto> {
    const user = await this.users.setRichMenuType(lineUserId, dto.richMenuType);
    if (!user) {
      throw new NotFoundException(`No active LINE user '${lineUserId}'.`);
    }
    try {
      await this.users.applyRichMenu(user);
    } catch (error) {
      throw new BadGatewayException(
        error instanceof Error
          ? error.message
          : 'Failed to apply rich menu on LINE.',
      );
    }
    return this.users.toDto(user);
  }
}
