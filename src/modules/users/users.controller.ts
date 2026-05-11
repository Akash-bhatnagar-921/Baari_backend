import { Controller, UseGuards, Patch, Req, Body, Get } from '@nestjs/common';
import { JwtAuthGuard } from 'common/guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}
  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  updateProfile(@Body() body: any, @Req() req: any) {
    return this.usersService.updateProfile(req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@Req() req: any) {
    console.log('REQ USER =>', req.user);
    return this.usersService.getProfile(req.user.userId);
  }
}
