import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SalonsController } from './salons.controller';
import { SalonsService } from './salons.service';

import { Salon } from './entities/salon.entity';
import { Service } from './entities/service.entity';
import { Amenity } from './entities/amenity.entity';
import { SalonService } from './entities/salon-service.entity';
import { Barber } from './entities/barber.entity';
import { SalonAmenity } from './entities/salon-amenity.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Salon,
      Service,
      Amenity,
      SalonService,
      Barber,
      SalonAmenity,
    ]),
  ],
  controllers: [SalonsController],
  providers: [SalonsService],
})
export class SalonsModule {}