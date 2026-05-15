import {
  Param,
  Controller,
  Post,
  Body,
  Get,
  HttpCode,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SalonsService } from './salons.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateSalonDto } from './dto/create-salon.dto';

@Controller('salons')
export class SalonsController {
  constructor(private readonly salonsService: SalonsService) {}

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

  @Get('franchises')
  searchFranchises(@Query('q') q: string) {
    return this.salonsService.searchFranchises(q ?? '');
  }

  @Get('nearby')
  findNearby(
    @Query('lat')       lat: string,
    @Query('lng')       lng: string,
    @Query('radius')    radius?: string,
    @Query('amenities') amenities?: string,
    @Query('services')  services?: string,
    @Query('sort')      sort?: string,
  ) {
    const latNum   = parseFloat(lat);
    const lngNum   = parseFloat(lng);
    const radiusKm = radius ? parseFloat(radius) : 1;

    if (isNaN(latNum) || isNaN(lngNum)) return [];

    return this.salonsService.searchSalons({
      lat:       latNum,
      lng:       lngNum,
      radiusKm,
      amenities: amenities ? amenities.split(',').map((s) => s.trim()) : [],
      services:  services  ? services.split(',').map((s) => s.trim())  : [],
      sort:      (sort as any) ?? 'distance_asc',
    });
  }

  @Get('seed-services')
  seedServices() {
    return this.salonsService.seedServices();
  }

  @Get('services')
  getServices() {
    return this.salonsService.getServices();
  }

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

  @Patch(':id/approve')
  approveSalon(@Param('id') id: string) {
    return this.salonsService.approveSalon(id);
  }
}
