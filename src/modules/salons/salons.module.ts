import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { SalonsController } from './salons.controller';
import { SalonsService } from './salons.service';

import { Salon } from './entities/salon.entity';
import { Service } from './entities/service.entity';
import { Amenity } from './entities/amenity.entity';
import { SalonService } from './entities/salon-service.entity';
import { Barber } from './entities/barber.entity';
import { SalonAmenity } from './entities/salon-amenity.entity';
import { SalonFranchise } from './entities/salon-franchise.entity';
import { SalonFranchiseOwner } from './entities/salon-franchise-owner.entity';
import { Review } from './entities/review.entity';

@Module({
  imports: [
    AuthModule,  // provides JwtService (via JwtModule) and EmailQueueService
    UsersModule, // provides PushNotificationService
    TypeOrmModule.forFeature([
      Salon,
      Service,
      Amenity,
      SalonService,
      Barber,
      SalonAmenity,
      SalonFranchise,
      SalonFranchiseOwner,
      Review,
    ]),
  ],
  controllers: [SalonsController],
  providers: [SalonsService],
})
export class SalonsModule {}
