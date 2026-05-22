import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PushNotificationService } from './push-notification.service';
import { User } from './user.entity';
import { Wishlist } from './wishlist.entity';
import { Subscription } from './subscription.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([User, Wishlist, Subscription]),
  ],
  controllers: [UsersController],
  providers: [UsersService, PushNotificationService],
  exports: [UsersService, PushNotificationService],
})
export class UsersModule {}
