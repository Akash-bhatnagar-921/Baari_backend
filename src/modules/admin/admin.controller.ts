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
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
    @Query('role')   role?: string,
  ) {
    return this.adminService.getUsers(
      Number(page ?? 1), Number(limit ?? 20), search ?? '', role ?? '',
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
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.adminService.getBookings(
      Number(page ?? 1), Number(limit ?? 20), search ?? '', status ?? '',
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
  @Delete('offers/:id')
  @HttpCode(200)
  deleteOffer(@Param('id') id: string) {
    return this.adminService.deleteOffer(id);
  }
}
