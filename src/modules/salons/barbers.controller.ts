import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SalonsService } from './salons.service';

@Controller('barbers')
export class BarbersController {
  constructor(private readonly salonsService: SalonsService) {}

  /** Customer: list barbers they follow. Must be before /:id to avoid param collision. */
  @UseGuards(JwtAuthGuard)
  @Get('following')
  getFollowedBarbers(@Req() req: any) {
    return this.salonsService.getFollowedBarbers(req.user.userId);
  }

  /** Public: full barber profile — stats, gallery, schedule. */
  @Get(':id')
  getBarberProfile(@Param('id') id: string) {
    return this.salonsService.getBarberProfile(id);
  }

  /** Customer: follow a barber. */
  @UseGuards(JwtAuthGuard)
  @Post(':id/follow')
  @HttpCode(200)
  followBarber(@Param('id') id: string, @Req() req: any) {
    return this.salonsService.followBarber(req.user.userId, id);
  }

  /** Customer: unfollow a barber. */
  @UseGuards(JwtAuthGuard)
  @Delete(':id/follow')
  @HttpCode(200)
  unfollowBarber(@Param('id') id: string, @Req() req: any) {
    return this.salonsService.unfollowBarber(req.user.userId, id);
  }
}
