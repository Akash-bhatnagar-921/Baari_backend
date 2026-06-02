import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  /** Available time slots (5-min intervals, available only). */
  @Get('slots')
  getSlots(@Query('salonId') salonId: string, @Query('date') date: string) {
    return this.bookingsService.getAvailableSlots(
      salonId,
      date ?? new Date().toISOString().split('T')[0],
    );
  }

  /** Customer: active upcoming booking (pending or confirmed). */
  @UseGuards(JwtAuthGuard)
  @Get('active')
  getActiveBooking(@Req() req: any) {
    return this.bookingsService.getActiveBooking(req.user.userId);
  }

  /** Customer: count of non-cancelled bookings this calendar month. */
  @UseGuards(JwtAuthGuard)
  @Get('monthly-count')
  getMonthlyBookingCount(@Req() req: any) {
    return this.bookingsService.getMonthlyBookingCount(req.user.userId);
  }

  /** Professional: count of non-cancelled bookings for their salon this month. */
  @UseGuards(JwtAuthGuard)
  @Get('professional/monthly-count')
  getProfessionalMonthlyBookingCount(@Req() req: any) {
    return this.bookingsService.getProfessionalMonthlyBookingCount(
      req.user.userId,
    );
  }

  /** Professional: earnings summary + completed bookings. */
  @UseGuards(JwtAuthGuard)
  @Get('earnings')
  getEarnings(@Req() req: any) {
    return this.bookingsService.getEarnings(req.user.userId);
  }

  /** Customer: last completed booking for "Book Your Usual" flow. */
  @UseGuards(JwtAuthGuard)
  @Get('last-completed')
  getLastCompletedBooking(@Req() req: any) {
    return this.bookingsService.getLastCompletedBooking(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('my')
  getUserBookings(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.bookingsService.getUserBookings(req.user.userId, page, limit);
  }

  @UseGuards(JwtAuthGuard)
  @Get('salon')
  getSalonBookings(@Req() req: any) {
    return this.bookingsService.getSalonBookings(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  createBooking(
    @Req() req: any,
    @Body()
    body: {
      salonId: string;
      salonName: string;
      scheduledAt: string;
      services: Array<{
        serviceId: string;
        serviceName: string;
        price: number;
        duration: number;
      }>;
    },
  ) {
    return this.bookingsService.createBooking(
      req.user.userId,
      body.salonId,
      body.scheduledAt,
      body.services,
      body.salonName ?? '',
    );
  }

  /** Professional: accept a pending booking (generates OTP). */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/accept')
  acceptBooking(@Req() req: any, @Param('id') id: string) {
    return this.bookingsService.acceptBooking(id, req.user.userId);
  }

  /** Professional: reject a pending booking. */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/reject')
  rejectBooking(@Req() req: any, @Param('id') id: string) {
    return this.bookingsService.rejectBooking(id, req.user.userId);
  }

  /** Professional: mark a booking as completed. */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/complete')
  completeBooking(@Req() req: any, @Param('id') id: string) {
    return this.bookingsService.completeBooking(id, req.user.userId);
  }

  /** Professional: verify customer OTP → start appointment (in_progress). */
  @UseGuards(JwtAuthGuard)
  @Post(':id/verify-otp')
  verifyOtp(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { otp: string },
  ) {
    if (!body?.otp) throw new BadRequestException('otp is required');
    return this.bookingsService.verifyBookingOtp(id, req.user.userId, body.otp);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/services')
  modifyServices(
    @Req() req: any,
    @Param('id') id: string,
    @Body()
    body: {
      services: Array<{
        serviceId: string;
        serviceName: string;
        price: number;
        duration: number;
      }>;
    },
  ) {
    return this.bookingsService.modifyBookingServices(
      id,
      req.user.userId,
      body.services ?? [],
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  cancelBooking(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body?: { reason?: string },
  ) {
    return this.bookingsService.cancelBooking(id, req.user.userId, body?.reason);
  }
}
