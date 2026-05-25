import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingReminderService } from './booking-reminder.service';
import { Booking } from './entities/booking.entity';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AuthModule,
    UsersModule,
    TypeOrmModule.forFeature([Booking]),
  ],
  controllers: [BookingsController],
  providers: [BookingsService, BookingReminderService],
})
export class BookingsModule {}
