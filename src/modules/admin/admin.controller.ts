import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ── Bootstrap — no auth required ──────────────────────────────────────────

  /** Create the very first admin account (protected by ADMIN_SEED_SECRET env var). */
  @Post('seed')
  @HttpCode(201)
  seedAdmin(@Body() body: any) {
    return this.adminService.seedAdmin(body);
  }

  /** Admin phone + password login. Returns 8-hour JWT. */
  @Post('auth/login')
  @HttpCode(200)
  login(@Body() body: { phone: string; password: string }) {
    return this.adminService.adminLogin(body.phone, body.password);
  }

  // ── All routes below require a valid admin JWT ────────────────────────────

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('stats')
  getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('users')
  getUsers(
    @Query('page')     page?: string,
    @Query('limit')    limit?: string,
    @Query('search')   search?: string,
    @Query('role')     role?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo')   dateTo?: string,
  ) {
    return this.adminService.getUsers(
      Number(page ?? 1), Number(limit ?? 20), search ?? '', role ?? '',
      dateFrom, dateTo,
    );
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('users/:id/subscription')
  @HttpCode(200)
  setUserSubscription(@Param('id') id: string, @Body() body: any) {
    return this.adminService.adminSetSubscription(id, body.plan, body.durationDays);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Delete('users/:id/subscription')
  @HttpCode(200)
  cancelUserSubscription(@Param('id') id: string) {
    return this.adminService.adminCancelSubscription(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('users/:id/bookings')
  getUserBookings(
    @Param('id') id: string,
    @Query('page')     page?: string,
    @Query('limit')    limit?: string,
    @Query('status')   status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo')   dateTo?: string,
  ) {
    return this.adminService.getUserBookings(
      id, Number(page ?? 1), Number(limit ?? 20), status, dateFrom, dateTo,
    );
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('users/:id')
  getUserDetail(@Param('id') id: string) {
    return this.adminService.getUserDetail(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('users/:id')
  updateUser(@Param('id') id: string, @Body() body: any) {
    return this.adminService.updateUser(id, body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('users/:id/ban')
  @HttpCode(200)
  banUser(
    @Param('id') id: string,
    @Body() body: { durationHours?: number | null; reason?: string },
  ) {
    return this.adminService.banUser(id, body.durationHours ?? null, body.reason ?? '');
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('users/:id/unban')
  @HttpCode(200)
  unbanUser(@Param('id') id: string) {
    return this.adminService.unbanUser(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Delete('users/:id')
  @HttpCode(200)
  deleteUser(@Param('id') id: string) {
    return this.adminService.deleteUser(id);
  }

  // ── Salons ──────────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('salons')
  getSalons(
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.adminService.getSalons(
      Number(page ?? 1), Number(limit ?? 20), search ?? '', status ?? '',
    );
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('salons/:id/bookings')
  getSalonBookings(
    @Param('id') id: string,
    @Query('page')     page?: string,
    @Query('limit')    limit?: string,
    @Query('status')   status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo')   dateTo?: string,
  ) {
    return this.adminService.getSalonBookings(
      id, Number(page ?? 1), Number(limit ?? 20), status, dateFrom, dateTo,
    );
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('salons/:id')
  getSalonDetail(@Param('id') id: string) {
    return this.adminService.getSalonDetail(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('salons')
  @HttpCode(201)
  createSalon(@Body() body: any) {
    return this.adminService.createSalonByAdmin(body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('salons/:id')
  updateSalon(@Param('id') id: string, @Body() body: any) {
    return this.adminService.updateSalon(id, body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Delete('salons/:id')
  @HttpCode(200)
  deleteSalon(@Param('id') id: string) {
    return this.adminService.deleteSalon(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('salons/:id/ban')
  @HttpCode(200)
  banSalon(
    @Param('id') id: string,
    @Body() body: { durationHours?: number | null; reason?: string },
  ) {
    return this.adminService.banSalon(id, body.durationHours ?? null, body.reason ?? '');
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('salons/:id/unban')
  @HttpCode(200)
  unbanSalon(@Param('id') id: string) {
    return this.adminService.unbanSalon(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('salons/:id/approve')
  @HttpCode(200)
  approveSalon(@Param('id') id: string) {
    return this.adminService.approveSalon(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('salons/:id/reject')
  @HttpCode(200)
  rejectSalon(@Param('id') id: string) {
    return this.adminService.rejectSalon(id);
  }

  // ── Bookings ────────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('bookings')
  getBookings(
    @Query('page')     page?: string,
    @Query('limit')    limit?: string,
    @Query('search')   search?: string,
    @Query('status')   status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo')   dateTo?: string,
  ) {
    return this.adminService.getBookings(
      Number(page ?? 1), Number(limit ?? 20), search ?? '', status ?? '',
      dateFrom, dateTo,
    );
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('bookings/:id')
  getBookingDetail(@Param('id') id: string) {
    return this.adminService.getBookingDetail(id);
  }

  // ── Offers ──────────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('offers')
  getAllOffers(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.adminService.getAllOffers(Number(page ?? 1), Number(limit ?? 30));
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('offers')
  @HttpCode(201)
  createOffer(@Body() body: any) {
    return this.adminService.adminCreateOffer(body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('offers/:id')
  @HttpCode(200)
  updateOffer(@Param('id') id: string, @Body() body: any) {
    return this.adminService.adminUpdateOffer(id, body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Delete('offers/:id')
  @HttpCode(200)
  deleteOffer(@Param('id') id: string) {
    return this.adminService.deleteOffer(id);
  }

  // ── Coupons ──────────────────────────────────────────────────────────────────

  // ── Coupon assignments ───────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('coupons/:id/assign')
  @HttpCode(200)
  assignCoupon(@Param('id') id: string, @Body() body: any) {
    return this.adminService.adminAssignCoupon(id, body.userIds ?? []);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('coupons/:id/assignees')
  getCouponAssignees(@Param('id') id: string) {
    return this.adminService.adminGetCouponAssignees(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Delete('coupons/:id/assignees/:userId')
  @HttpCode(200)
  removeCouponAssignee(@Param('id') id: string, @Param('userId') userId: string) {
    return this.adminService.adminRemoveCouponAssignee(id, userId);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('coupons')
  getCoupons(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.adminService.getCoupons(Number(page ?? 1), Number(limit ?? 50));
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('coupons')
  @HttpCode(201)
  createCoupon(@Body() body: any) {
    return this.adminService.createCoupon(body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('coupons/:id/toggle')
  @HttpCode(200)
  toggleCoupon(@Param('id') id: string) {
    return this.adminService.toggleCoupon(id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Delete('coupons/:id')
  @HttpCode(200)
  deleteCoupon(@Param('id') id: string) {
    return this.adminService.deleteCoupon(id);
  }

  // ── Complaints ──────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('complaints')
  getComplaints(
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('type')   type?: string,
    @Query('status') status?: string,
  ) {
    return this.adminService.getComplaints(
      Number(page ?? 1), Number(limit ?? 20), type ?? '', status ?? '',
    );
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('complaints/:id')
  @HttpCode(200)
  resolveComplaint(@Param('id') id: string, @Body() body: { status: string }) {
    return this.adminService.resolveComplaint(id, body.status);
  }

  // ── Sub-admins ──────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('sub-admins')
  @HttpCode(201)
  createSubAdmin(@Body() body: any) {
    return this.adminService.adminCreateSubAdmin(body);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('sub-admins')
  listSubAdmins() {
    return this.adminService.adminListSubAdmins();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('sub-admins/:id/permissions')
  @HttpCode(200)
  updateSubAdminPermissions(@Param('id') id: string, @Body() body: any) {
    return this.adminService.adminUpdateSubAdminPermissions(id, body.permissions ?? {});
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Delete('sub-admins/:id')
  @HttpCode(200)
  deleteSubAdmin(@Param('id') id: string) {
    return this.adminService.adminDeleteSubAdmin(id);
  }
}
