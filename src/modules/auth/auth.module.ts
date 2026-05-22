import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginOtp } from './entities/login-otp.entity';
import { JWT_SECRET_FALLBACK } from './jwt.constants';
import { EmailQueueService } from './services/email-queue.service';
import { SmsService } from './services/sms.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([LoginOtp]),
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') ?? JWT_SECRET_FALLBACK,
        signOptions: {
          expiresIn: '30d',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, EmailQueueService, SmsService, JwtStrategy],
  exports: [JwtModule, EmailQueueService, SmsService],
})
export class AuthModule {}
