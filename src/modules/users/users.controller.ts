import {
  Controller,
  UseGuards,
  Patch,
  Delete,
  Post,
  Req,
  Body,
  Get,
  HttpCode,
  Param,
  Query,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  // ── Profile ───────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  updateProfile(@Body() body: UpdateProfileDto, @Req() req: any) {
    return this.usersService.updateProfile(req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@Req() req: any) {
    return this.usersService.getProfile(req.user.userId);
  }

  /** Professional: look up a customer name by phone for offline booking auto-fill. */
  @UseGuards(JwtAuthGuard)
  @Get('lookup-by-phone')
  async lookupByPhone(@Query('phone') phone: string, @Req() req: any) {
    if (!phone?.trim()) throw new BadRequestException('phone is required');
    const result = await this.usersService.lookupCustomerByPhone(
      phone.trim(),
      req.user.userId,
    );
    if (!result) throw new NotFoundException('No customer account found with that phone number');
    return result;
  }

  @UseGuards(JwtAuthGuard)
  @Delete('me')
  @HttpCode(200)
  deleteAccount(@Req() req: any) {
    return this.usersService.deleteAccount(req.user.userId);
  }

  // ── Subscription ──────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Patch('fcm-token')
  @HttpCode(200)
  saveFcmToken(@Req() req: any, @Body() body: { token: string }) {
    return this.usersService.saveFcmToken(req.user.userId, body.token ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Get('subscription')
  getSubscription(@Req() req: any) {
    return this.usersService.getSubscription(req.user.userId);
  }

  /** Professional: current plan details with feature limits. */
  @UseGuards(JwtAuthGuard)
  @Get('subscription/professional')
  getProfessionalSubscription(@Req() req: any) {
    return this.usersService.getProfessionalSubscription(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('subscription/order')
  @HttpCode(200)
  createSubscriptionOrder(@Body() body: { plan: string }, @Req() req: any) {
    if (!body?.plan) throw new BadRequestException('plan is required');
    return this.usersService.createSubscriptionOrder(req.user.userId, body.plan);
  }

  @UseGuards(JwtAuthGuard)
  @Post('subscription')
  @HttpCode(200)
  createSubscription(
    @Body()
    body: {
      plan: string;
      paymentId?: string;
      orderId?: string;
      signature?: string;
    },
    @Req() req: any,
  ) {
    if (!body?.plan) throw new BadRequestException('plan is required');
    const payment =
      body.paymentId && body.orderId && body.signature
        ? { paymentId: body.paymentId, orderId: body.orderId, signature: body.signature }
        : undefined;
    return this.usersService.createSubscription(req.user.userId, body.plan, payment);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('subscription')
  @HttpCode(200)
  cancelSubscription(@Req() req: any) {
    return this.usersService.cancelSubscription(req.user.userId);
  }

  // ── Wishlist ───────────────────────────────────────────────────────────────

  /** Returns all wishlisted salons with full details. */
  @UseGuards(JwtAuthGuard)
  @Get('wishlist')
  getWishlist(@Req() req: any) {
    return this.usersService.getWishlist(req.user.userId);
  }

  /** Returns only the salonIds — cheap call to sync heart icons. */
  @UseGuards(JwtAuthGuard)
  @Get('wishlist/ids')
  getWishlistIds(@Req() req: any) {
    return this.usersService.getWishlistIds(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('wishlist/:salonId')
  @HttpCode(200)
  addToWishlist(@Param('salonId') salonId: string, @Req() req: any) {
    return this.usersService.addToWishlist(req.user.userId, salonId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('wishlist/:salonId')
  @HttpCode(200)
  removeFromWishlist(@Param('salonId') salonId: string, @Req() req: any) {
    return this.usersService.removeFromWishlist(req.user.userId, salonId);
  }

  // ── Complaints ─────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('complaints')
  @HttpCode(201)
  submitComplaint(
    @Req() req: any,
    @Body() body: {
      type: 'user' | 'salon';
      targetId: string;
      reason: string;
      description?: string;
      severity?: 'minor' | 'major';
    },
  ) {
    return this.usersService.submitComplaint(
      req.user.userId,
      body.type,
      body.targetId,
      body.reason,
      body.description ?? '',
      body.severity ?? 'minor',
    );
  }
}
