import {
  Param,
  Controller,
  Post,
  Body,
  Get,
  HttpCode,
  Patch,
  Put,
  Delete,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { SalonsService } from './salons.service';
import { OffersService } from './offers.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CreateSalonDto } from './dto/create-salon.dto';

@Controller('salons')
export class SalonsController {
  constructor(
    private readonly salonsService: SalonsService,
    private readonly offersService: OffersService,
  ) {}

  @Post()
  createSalon(@Body() body: CreateSalonDto) {
    return this.salonsService.createSalon(body);
  }

  @Post('verify-code')
  @HttpCode(200)
  verifySalonCode(@Body() body: { phone: string; code: string }) {
    return this.salonsService.verifySalonCode(body.phone, body.code);
  }

  @UseGuards(JwtAuthGuard)
  @Get('my')
  getMySalons(@Req() req: any) {
    return this.salonsService.getMySalons(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('my/config')
  getMySalonConfig(@Req() req: any) {
    return this.salonsService.getMySalonConfig(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Put('my/services')
  updateMySalonServices(
    @Req() req: any,
    @Body()
    body: {
      services: Array<{
        serviceId?: string;
        serviceName: string;
        price: number;
        duration?: number;
      }>;
    },
  ) {
    return this.salonsService.updateMySalonServices(
      req.user.userId,
      body.services ?? [],
    );
  }

  @UseGuards(JwtAuthGuard)
  @Put('my/amenities')
  updateMySalonAmenities(
    @Req() req: any,
    @Body()
    body: { amenities: Array<{ amenityId?: string; amenityName: string }> },
  ) {
    return this.salonsService.updateMySalonAmenities(
      req.user.userId,
      body.amenities ?? [],
    );
  }

  @Get('franchises')
  searchFranchises(@Query('q') q: string) {
    return this.salonsService.searchFranchises(q ?? '');
  }

  /** Public: trending salons + popular services, optionally filtered by city. */
  @Get('trending')
  getTrending(@Query('city') city?: string) {
    return this.salonsService.getTrendingSalons(city);
  }

  @Get('nearby')
  findNearby(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radius') radius?: string,
    @Query('amenities') amenities?: string,
    @Query('services') services?: string,
    @Query('sort') sort?: string,
  ) {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const radiusKm = radius ? parseFloat(radius) : 1;

    if (isNaN(latNum) || isNaN(lngNum)) return [];

    return this.salonsService.searchSalons({
      lat: latNum,
      lng: lngNum,
      radiusKm,
      amenities: amenities ? amenities.split(',').map((s) => s.trim()) : [],
      services: services ? services.split(',').map((s) => s.trim()) : [],
      sort: (sort as any) ?? 'distance_asc',
    });
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('seed-services')
  seedServices() {
    return this.salonsService.seedServices();
  }

  @Get('services')
  getServices() {
    return this.salonsService.getServices();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('seed-amenities')
  seedAmenities() {
    return this.salonsService.seedAmenities();
  }

  @Get('amenities')
  getAmenities() {
    return this.salonsService.getAmenities();
  }

  @Get()
  getAllSalons() {
    return this.salonsService.getAllSalons();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch(':id/approve')
  approveSalon(@Param('id') id: string) {
    return this.salonsService.approveSalon(id);
  }

  /** Professional: mark salon as open or closed. */
  @UseGuards(JwtAuthGuard)
  @Patch('my/open-status')
  toggleSalonOpen(@Req() req: any, @Body() body: { isOpen: boolean }) {
    return this.salonsService.toggleSalonOpen(
      req.user.userId,
      body.isOpen ?? true,
    );
  }

  /** Professional: upload a cover photo for their salon. */
  @UseGuards(JwtAuthGuard)
  @Post('my/photo')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.cwd(), 'uploads', 'salons');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
          cb(null, `${unique}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.match(/^image\/(jpeg|jpg|png|webp)$/)) {
          return cb(new BadRequestException('Only JPEG, PNG, or WebP images are allowed.'), false);
        }
        cb(null, true);
      },
    }),
  )
  uploadSalonPhoto(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No photo file received.');
    return this.salonsService.updateSalonPhoto(req.user.userId, `/uploads/salons/${file.filename}`);
  }

  /** Professional: submit a new salon location for admin approval. */
  @UseGuards(JwtAuthGuard)
  @Patch('my/location')
  updateMyLocation(
    @Req() req: any,
    @Body() body: { lat: number; lng: number; address: string },
  ) {
    return this.salonsService.updateMyLocation(
      req.user.userId,
      body.lat,
      body.lng,
      body.address ?? '',
    );
  }

  /** Professional: update city/state/pincode — requires admin approval to go live. */
  @UseGuards(JwtAuthGuard)
  @Patch('my/address')
  updateSalonAddress(
    @Req() req: any,
    @Body()
    body: { city: string; state: string; pincode?: string; address?: string },
  ) {
    if (!body?.city || !body?.state) {
      throw new BadRequestException('city and state are required');
    }
    return this.salonsService.updateSalonAddress(req.user.userId, body);
  }

  /** Admin utility — geocodes all approved salons that are missing coordinates. */
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('admin/sync-geocodes')
  syncMissingGeocodesAdmin() {
    return this.salonsService.syncMissingGeocodesAdmin();
  }

  /** Professional: update opening/closing times and working days. */
  @UseGuards(JwtAuthGuard)
  @Patch('my/hours')
  updateMyHours(
    @Req() req: any,
    @Body()
    body: { openingTime?: string; closingTime?: string; workingDays?: string },
  ) {
    return this.salonsService.updateWorkingHours(
      req.user.userId,
      body.openingTime ?? '',
      body.closingTime ?? '',
      body.workingDays ?? '',
    );
  }

  /** Professional: reviews received for own salon. */
  @UseGuards(JwtAuthGuard)
  @Get('my/reviews')
  getMyReviews(@Req() req: any) {
    return this.salonsService.getMyReviews(req.user.userId);
  }

  /** Professional: list barbers for own salon. */
  @UseGuards(JwtAuthGuard)
  @Get('my/barbers')
  getMyBarbers(@Req() req: any) {
    return this.salonsService.getMyBarbers(req.user.userId);
  }

  /** Professional: add a barber to own salon. */
  @UseGuards(JwtAuthGuard)
  @Post('my/barbers')
  addBarber(
    @Req() req: any,
    @Body() body: { name: string; experience?: number; workingDays?: string },
  ) {
    if (!body?.name) throw new BadRequestException('name is required');
    return this.salonsService.addBarber(
      req.user.userId,
      body.name,
      body.experience ?? 0,
      body.workingDays,
    );
  }

  /** Professional: update a barber's name / experience / availability. */
  @UseGuards(JwtAuthGuard)
  @Patch('my/barbers/:barberId')
  updateBarber(
    @Req() req: any,
    @Param('barberId') barberId: string,
    @Body() body: { name?: string; experience?: number; workingDays?: string | null },
  ) {
    return this.salonsService.updateBarber(req.user.userId, barberId, body);
  }

  /** Professional: remove a barber from own salon. */
  @UseGuards(JwtAuthGuard)
  @Delete('my/barbers/:barberId')
  @HttpCode(200)
  deleteBarber(@Req() req: any, @Param('barberId') barberId: string) {
    return this.salonsService.deleteBarber(req.user.userId, barberId);
  }

  /** Professional: update barber profile info (specialization, bio, hours). */
  @UseGuards(JwtAuthGuard)
  @Patch('my/barbers/:barberId/profile')
  updateBarberProfile(
    @Req() req: any,
    @Param('barberId') barberId: string,
    @Body() body: { specialization?: string; bio?: string; openingTime?: string; closingTime?: string },
  ) {
    return this.salonsService.updateBarberProfile(req.user.userId, barberId, body);
  }

  /** Professional: set barber availability (available / on leave / on break). */
  @UseGuards(JwtAuthGuard)
  @Patch('my/barbers/:barberId/availability')
  setBarberAvailability(
    @Req() req: any,
    @Param('barberId') barberId: string,
    @Body() body: { isAvailable: boolean; leaveUntil?: string | null; breakUntil?: string | null },
  ) {
    return this.salonsService.setBarberAvailability(req.user.userId, barberId, body);
  }

  /** Professional: upload barber profile photo. */
  @UseGuards(JwtAuthGuard)
  @Post('my/barbers/:barberId/photo')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.cwd(), 'uploads', 'barbers');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
          cb(null, `${unique}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.match(/^image\/(jpeg|jpg|png|webp)$/)) {
          return cb(new BadRequestException('Only JPEG, PNG, or WebP images are allowed.'), false);
        }
        cb(null, true);
      },
    }),
  )
  uploadBarberPhoto(
    @Req() req: any,
    @Param('barberId') barberId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No photo file received.');
    return this.salonsService.uploadBarberPhoto(req.user.userId, barberId, `/uploads/barbers/${file.filename}`);
  }

  /** Professional: add a work photo to barber gallery. */
  @UseGuards(JwtAuthGuard)
  @Post('my/barbers/:barberId/gallery')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.cwd(), 'uploads', 'barbers', 'gallery');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
          cb(null, `${unique}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.match(/^image\/(jpeg|jpg|png|webp)$/)) {
          return cb(new BadRequestException('Only JPEG, PNG, or WebP images are allowed.'), false);
        }
        cb(null, true);
      },
    }),
  )
  addToBarberGallery(
    @Req() req: any,
    @Param('barberId') barberId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { caption?: string },
  ) {
    if (!file) throw new BadRequestException('No photo file received.');
    return this.salonsService.addToBarberGallery(
      req.user.userId, barberId,
      `/uploads/barbers/gallery/${file.filename}`,
      body?.caption,
    );
  }

  /** Professional: remove a photo from barber gallery by index. */
  @UseGuards(JwtAuthGuard)
  @Delete('my/barbers/:barberId/gallery/:index')
  @HttpCode(200)
  removeFromBarberGallery(
    @Req() req: any,
    @Param('barberId') barberId: string,
    @Param('index') index: string,
  ) {
    return this.salonsService.removeFromBarberGallery(req.user.userId, barberId, parseInt(index, 10));
  }

  /** Professional: update barber payroll settings (salary/commission). */
  @UseGuards(JwtAuthGuard)
  @Patch('my/barbers/:barberId/payroll')
  updateBarberPayroll(
    @Req() req: any,
    @Param('barberId') barberId: string,
    @Body() body: { baseSalary?: number; commissionRate?: number; salaryType?: string },
  ) {
    return this.salonsService.updateBarberPayrollSettings(req.user.userId, barberId, body);
  }

  // ── Walk-in queue ─────────────────────────────────────────────────────────────

  /** Professional: list today's (or a given date's) walk-ins. */
  @UseGuards(JwtAuthGuard)
  @Get('my/walk-ins')
  getWalkIns(@Req() req: any, @Query('date') date?: string) {
    return this.salonsService.getWalkIns(req.user.userId, date);
  }

  /** Professional: add a walk-in customer (optionally with a scheduled slot to block availability). */
  @UseGuards(JwtAuthGuard)
  @Post('my/walk-ins')
  @HttpCode(200)
  addWalkIn(
    @Req() req: any,
    @Body()
    body: {
      customerName: string;
      customerPhone?: string;
      barberId?: string;
      services?: Array<{
        serviceId?: string;
        serviceName: string;
        price: number;
        duration: number;
      }>;
      notes?: string;
      scheduledAt?: string;
    },
  ) {
    if (!body?.customerName) throw new BadRequestException('customerName is required');
    return this.salonsService.addWalkIn(req.user.userId, body);
  }

  /** Professional: update walk-in status / barber / notes. */
  @UseGuards(JwtAuthGuard)
  @Patch('my/walk-ins/:walkInId')
  updateWalkIn(
    @Req() req: any,
    @Param('walkInId') walkInId: string,
    @Body() body: { status?: string; barberId?: string; notes?: string },
  ) {
    return this.salonsService.updateWalkIn(req.user.userId, walkInId, body);
  }

  /** Professional: remove a walk-in record. */
  @UseGuards(JwtAuthGuard)
  @Delete('my/walk-ins/:walkInId')
  @HttpCode(200)
  deleteWalkIn(@Req() req: any, @Param('walkInId') walkInId: string) {
    return this.salonsService.deleteWalkIn(req.user.userId, walkInId);
  }

  // ── Schedule optimisation ──────────────────────────────────────────────────

  /** Professional: get schedule gaps and utilisation rate for a given date. */
  @UseGuards(JwtAuthGuard)
  @Get('my/schedule/gaps')
  getScheduleGaps(@Req() req: any, @Query('date') date?: string) {
    return this.salonsService.getScheduleGaps(req.user.userId, date);
  }

  // ── Inventory management ──────────────────────────────────────────────────

  /** Professional: list all inventory items. */
  @UseGuards(JwtAuthGuard)
  @Get('my/inventory')
  getInventory(@Req() req: any) {
    return this.salonsService.getInventory(req.user.userId);
  }

  /** Professional: add an inventory item. */
  @UseGuards(JwtAuthGuard)
  @Post('my/inventory')
  addInventoryItem(
    @Req() req: any,
    @Body()
    body: {
      name: string;
      category?: string;
      quantity?: number;
      unit?: string;
      minStock?: number;
      costPerUnit?: number;
      notes?: string;
    },
  ) {
    if (!body?.name) throw new BadRequestException('name is required');
    return this.salonsService.addInventoryItem(req.user.userId, body);
  }

  /** Professional: update an inventory item. */
  @UseGuards(JwtAuthGuard)
  @Patch('my/inventory/:itemId')
  updateInventoryItem(
    @Req() req: any,
    @Param('itemId') itemId: string,
    @Body()
    body: Partial<{
      name: string;
      category: string;
      quantity: number;
      unit: string;
      minStock: number;
      costPerUnit: number;
      notes: string;
    }>,
  ) {
    return this.salonsService.updateInventoryItem(req.user.userId, itemId, body);
  }

  /** Professional: delete an inventory item. */
  @UseGuards(JwtAuthGuard)
  @Delete('my/inventory/:itemId')
  @HttpCode(200)
  deleteInventoryItem(@Req() req: any, @Param('itemId') itemId: string) {
    return this.salonsService.deleteInventoryItem(req.user.userId, itemId);
  }

  // ── Attendance ────────────────────────────────────────────────────────────

  /** Professional: get monthly attendance for all barbers. */
  @UseGuards(JwtAuthGuard)
  @Get('my/attendance')
  getAttendance(
    @Req() req: any,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const now = new Date();
    return this.salonsService.getAttendance(
      req.user.userId,
      month ? parseInt(month, 10) : now.getMonth() + 1,
      year ? parseInt(year, 10) : now.getFullYear(),
    );
  }

  /** Professional: record or update a barber's attendance for a date. */
  @UseGuards(JwtAuthGuard)
  @Post('my/attendance')
  @HttpCode(200)
  markAttendance(
    @Req() req: any,
    @Body()
    body: {
      barberId: string;
      date: string;
      clockIn?: string;
      clockOut?: string;
      status: string;
      notes?: string;
    },
  ) {
    if (!body?.barberId || !body?.date || !body?.status) {
      throw new BadRequestException('barberId, date and status are required');
    }
    return this.salonsService.markAttendance(req.user.userId, body);
  }

  // ── Payroll ────────────────────────────────────────────────────────────────

  /** Professional: monthly payroll summary for all barbers. */
  @UseGuards(JwtAuthGuard)
  @Get('my/payroll')
  getPayrollSummary(
    @Req() req: any,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const now = new Date();
    return this.salonsService.getPayrollSummary(
      req.user.userId,
      month ? parseInt(month, 10) : now.getMonth() + 1,
      year ? parseInt(year, 10) : now.getFullYear(),
    );
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  /** Professional: advanced analytics for the salon. */
  @UseGuards(JwtAuthGuard)
  @Get('my/analytics')
  getSalonAnalytics(@Req() req: any, @Query('period') period?: string) {
    return this.salonsService.getSalonAnalytics(req.user.userId, period ?? '30d');
  }

  /** Public: get salon portfolio photos. */
  @Get('portfolio/active')
  getSalonPortfolioByQuery(@Query('salonId') salonId: string) {
    if (!salonId) return [];
    return this.salonsService.getSalonPortfolio(salonId);
  }

  /** Professional: upload a portfolio / before-after photo. */
  @UseGuards(JwtAuthGuard)
  @Post('my/portfolio')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.cwd(), 'uploads', 'portfolio');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
          cb(null, `${unique}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.match(/^image\/(jpeg|jpg|png|webp)$/)) {
          return cb(new BadRequestException('Only JPEG, PNG, or WebP images are allowed.'), false);
        }
        cb(null, true);
      },
    }),
  )
  uploadPortfolioPhoto(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { type?: string; caption?: string; beforeUrl?: string },
  ) {
    if (!file) throw new BadRequestException('No photo file received.');
    return this.salonsService.addSalonPortfolio(req.user.userId, {
      type: body?.type ?? 'portfolio',
      photoUrl: `/uploads/portfolio/${file.filename}`,
      beforeUrl: body?.beforeUrl,
      caption: body?.caption,
    });
  }

  /** Professional: delete a portfolio photo. */
  @UseGuards(JwtAuthGuard)
  @Delete('my/portfolio/:photoId')
  @HttpCode(200)
  deletePortfolioPhoto(@Req() req: any, @Param('photoId') photoId: string) {
    return this.salonsService.deleteSalonPortfolio(req.user.userId, photoId);
  }

  /** Public: list reviews for a salon. */
  @Get(':id/reviews')
  getSalonReviews(@Param('id') id: string) {
    return this.salonsService.getSalonReviews(id);
  }

  /** Customer: most booked salons this week near a location. */
  @Get('trending')
  getTrendingSalons(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radius') radius?: string,
  ) {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum)) return [];
    return this.salonsService.getTrendingSalons(
      latNum,
      lngNum,
      radius ? parseFloat(radius) : 10,
    );
  }

  /** Customer: live queue info for a salon. */
  @Get(':id/queue')
  getSalonQueue(@Param('id') id: string) {
    return this.salonsService.getSalonQueue(id);
  }

  /** Public: portfolio photos for a specific salon. */
  @Get(':id/portfolio')
  getSalonPortfolio(@Param('id') id: string) {
    return this.salonsService.getSalonPortfolio(id);
  }

  /** Customer-facing salon detail — services with price/duration, amenities, barber count, barbers. */
  @Get(':id')
  getSalonById(@Param('id') id: string) {
    return this.salonsService.getSalonById(id);
  }

  /** Submit or update a review for a salon. Requires a booking at that salon. */
  @UseGuards(JwtAuthGuard)
  @Post(':id/reviews')
  @HttpCode(200)
  submitReview(
    @Param('id') salonId: string,
    @Req() req: any,
    @Body() body: { bookingId?: string; rating: number; comment?: string },
  ) {
    if (!body?.rating) throw new BadRequestException('rating is required');
    return this.salonsService.submitReview(
      req.user.userId,
      salonId,
      body.bookingId ?? null,
      body.rating,
      body.comment ?? '',
    );
  }

  // ── Offers ────────────────────────────────────────────────────────────────────

  // Customer: active offers for a specific salon
  @Get(':id/offers')
  getSalonOffers(@Param('id') salonId: string) {
    return this.offersService.getOffersBySalon(salonId);
  }

  // Customer: all active offers across all salons
  @Get('offers/active')
  getAllActiveOffers() {
    return this.offersService.getAllActiveOffers();
  }

  // Professional: list own offers
  @UseGuards(JwtAuthGuard)
  @Get('my/offers')
  getMyOffers(@Req() req: any) {
    return this.offersService.getMyOffers(req.user.userId);
  }

  // Professional: create offer
  @UseGuards(JwtAuthGuard)
  @Post('my/offers')
  createOffer(@Req() req: any, @Body() body: any) {
    return this.offersService.createOffer(req.user.userId, body);
  }

  // Professional: update offer
  @UseGuards(JwtAuthGuard)
  @Patch('my/offers/:offerId')
  updateOffer(@Req() req: any, @Param('offerId') offerId: string, @Body() body: any) {
    return this.offersService.updateOffer(offerId, req.user.userId, body);
  }

  // Professional: delete offer
  @UseGuards(JwtAuthGuard)
  @Delete('my/offers/:offerId')
  deleteOffer(@Req() req: any, @Param('offerId') offerId: string) {
    return this.offersService.deleteOffer(offerId, req.user.userId);
  }
}
