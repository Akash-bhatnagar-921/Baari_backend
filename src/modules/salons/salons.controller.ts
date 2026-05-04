import { Param, Controller, Post, Body, Get, Patch } from '@nestjs/common';
import { SalonsService } from './salons.service';
import { UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('salons')
export class SalonsController {
  constructor(private readonly salonsService: SalonsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  createSalon(@Body() body: any, @Req() req: any) {
    // TEMP user
    // const user = { id: 'a4887564-7dda-49bf-b39b-2d11030ffb72' };

    return this.salonsService.createSalon(body, req.user);
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
