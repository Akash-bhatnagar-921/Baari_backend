import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, randomInt } from 'crypto';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { LoginOtp } from './entities/login-otp.entity';
import { JWT_SECRET_FALLBACK } from './jwt.constants';
import { EmailQueueService } from './services/email-queue.service';
import { VerifyRegisterOtpDto } from './dto/login-otp.dto';

const LOGIN_OTP_TTL_MS = 5 * 60 * 1000;
const LOGIN_OTP_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_OTP_MAX_REQUESTS_PER_WINDOW = 40; // first send + 3 resends

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailQueueService: EmailQueueService,
    @InjectRepository(LoginOtp)
    private loginOtpRepo: Repository<LoginOtp>,
  ) {}

  async register(data: any) {
    this.validatePhone(data.phone);
    if (data.email) this.validateEmail(data.email);

    const existingUser = await this.usersService.findByPhoneOrEmail(
      data.phone,
      data.email,
    );

    if (existingUser) {
      throw new BadRequestException('Phone number or email already exists');
    }

    const user = await this.usersService.createUser({
      phone: data.phone,
      role: data.role,
      fullName: data.name,
      email: data.email,
      age: data.age,
      gender: data.gender,
      hasAcceptedTerms: data.hasAcceptedTerms,
      termsAcceptedAt: new Date(),
    });

    const payload = {
      sub: user.id,
      phone: user.phone,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user,
    };
  }

  async checkPhone(phone: string) {
    const user = await this.usersService.findByPhone(phone);
    return { exists: !!user };
  }

  async login(phone: string) {
    return this.requestLoginOtp(phone);
  }

  async requestLoginOtp(phone: string) {
    this.validatePhone(phone);

    const user = await this.usersService.findByPhone(phone);

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Email is optional for professionals. When absent the OTP is logged to
    // the server console so an admin can relay it to the user.
    const otpEmail = user.email ?? `${phone}@no-email.baari`;
    const hasEmail = !!user.email;

    const now = new Date();
    const windowStartedAt = new Date(now.getTime() - LOGIN_OTP_WINDOW_MS);
    const recentOtpCount = await this.loginOtpRepo.count({
      where: {
        phone,
        createdAt: MoreThan(windowStartedAt),
      },
    });

    if (recentOtpCount >= LOGIN_OTP_MAX_REQUESTS_PER_WINDOW) {
      const blockedUntil = new Date(
        windowStartedAt.getTime() + LOGIN_OTP_WINDOW_MS * 2,
      );

      await this.loginOtpRepo.save(
        this.loginOtpRepo.create({
          phone,
          email: otpEmail,
          otpHash: this.hashOtp('blocked'),
          expiresAt: now,
          invalidatedAt: now,
          blockedUntil,
        }),
      );

      throw new HttpException(
        {
          message: 'Too many OTP requests. Come after some time.',
          blockedUntil,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const previousOtp = await this.loginOtpRepo.findOne({
      where: {
        phone,
        usedAt: IsNull(),
        invalidatedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });

    const otp = await this.generateUniqueOtp(previousOtp?.otpHash);
    const otpHash = this.hashOtp(otp);
    const expiresAt = new Date(now.getTime() + LOGIN_OTP_TTL_MS);

    await this.loginOtpRepo.update(
      {
        phone,
        usedAt: IsNull(),
        invalidatedAt: IsNull(),
      },
      { invalidatedAt: now },
    );

    await this.loginOtpRepo.save(
      this.loginOtpRepo.create({
        phone,
        email: otpEmail,
        otpHash,
        expiresAt,
      }),
    );

    if (hasEmail) {
      await this.emailQueueService.enqueueLoginOtpEmail(user.email!, otp);
    } else {
      // No email on account — log OTP so admin can relay it to the user
      console.log(`[NO-EMAIL OTP] phone=${phone} otp=${otp}`);
    }

    return {
      message: hasEmail ? 'OTP sent to registered email' : 'OTP generated — contact Baari admin for your code',
      email: hasEmail ? this.maskEmail(user.email!) : null,
      role: user.role,
      expiresInSeconds: LOGIN_OTP_TTL_MS / 1000,
      resendRemaining: LOGIN_OTP_MAX_REQUESTS_PER_WINDOW - recentOtpCount - 1,
    };
  }

  async verifyLoginOtp(phone: string, otp: string) {
    this.validatePhone(phone);

    const user = await this.usersService.findByPhone(phone);

    if (!user) {
      throw new UnauthorizedException('Invalid OTP');
    }

    const now = new Date();
    const otpRecord = await this.loginOtpRepo.findOne({
      where: {
        phone,
        usedAt: IsNull(),
        invalidatedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
      order: { createdAt: 'DESC' },
    });

    if (!otpRecord || otpRecord.otpHash !== this.hashOtp(otp)) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    await this.loginOtpRepo.update(otpRecord.id, { usedAt: now });

    const payload = {
      sub: user.id,
      phone: user.phone,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user,
    };
  }

  async requestRegisterOtp(phone: string, email: string) {
    this.validatePhone(phone);
    if (email) this.validateEmail(email);

    const existingUser = await this.usersService.findByPhoneOrEmail(
      phone,
      email,
    );

    if (existingUser) {
      throw new BadRequestException('Phone number or email already exists');
    }

    return this.sendOtp(phone, email);
  }

  async verifyRegisterOtp(data: VerifyRegisterOtpDto) {
    this.validatePhone(data.phone);
    if (data.email) this.validateEmail(data.email);

    if (
      !data.name ||
      !data.role ||
      !data.gender ||
      !data.age ||
      !data.hasAcceptedTerms
    ) {
      throw new BadRequestException('Please fill all required signup details');
    }

    const existingUser = await this.usersService.findByPhoneOrEmail(
      data.phone,
      data.email,
    );

    if (existingUser) {
      throw new BadRequestException('Phone number or email already exists');
    }

    await this.verifyOtpRecord(data.phone, data.otp);

    return this.register(data);
  }

  private async generateUniqueOtp(previousOtpHash?: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const otp = randomInt(0, 1000000).toString().padStart(6, '0');
      const otpHash = this.hashOtp(otp);

      if (otpHash === previousOtpHash) {
        continue;
      }

      const existingActiveOtp = await this.loginOtpRepo.findOne({
        where: {
          otpHash,
          usedAt: IsNull(),
          invalidatedAt: IsNull(),
          expiresAt: MoreThan(new Date()),
        },
      });

      if (!existingActiveOtp) {
        return otp;
      }
    }

    throw new HttpException(
      'Unable to generate a unique OTP. Please try again.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private async sendOtp(phone: string, email: string) {
    const now = new Date();
    const windowStartedAt = new Date(now.getTime() - LOGIN_OTP_WINDOW_MS);
    const recentOtpCount = await this.loginOtpRepo.count({
      where: {
        phone,
        createdAt: MoreThan(windowStartedAt),
      },
    });

    if (recentOtpCount >= LOGIN_OTP_MAX_REQUESTS_PER_WINDOW) {
      const blockedUntil = new Date(
        windowStartedAt.getTime() + LOGIN_OTP_WINDOW_MS * 2,
      );

      await this.loginOtpRepo.save(
        this.loginOtpRepo.create({
          phone,
          email,
          otpHash: this.hashOtp('blocked'),
          expiresAt: now,
          invalidatedAt: now,
          blockedUntil,
        }),
      );

      throw new HttpException(
        {
          message: 'Too many OTP requests. Come after some time.',
          blockedUntil,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const previousOtp = await this.loginOtpRepo.findOne({
      where: {
        phone,
        usedAt: IsNull(),
        invalidatedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });

    const otp = await this.generateUniqueOtp(previousOtp?.otpHash);
    const otpHash = this.hashOtp(otp);
    const expiresAt = new Date(now.getTime() + LOGIN_OTP_TTL_MS);

    await this.loginOtpRepo.update(
      {
        phone,
        usedAt: IsNull(),
        invalidatedAt: IsNull(),
      },
      { invalidatedAt: now },
    );

    await this.loginOtpRepo.save(
      this.loginOtpRepo.create({
        phone,
        email,
        otpHash,
        expiresAt,
      }),
    );

    await this.emailQueueService.enqueueLoginOtpEmail(email, otp);

    return {
      message: 'OTP sent to registered email',
      email: this.maskEmail(email),
      expiresInSeconds: LOGIN_OTP_TTL_MS / 1000,
      resendRemaining: LOGIN_OTP_MAX_REQUESTS_PER_WINDOW - recentOtpCount - 1,
    };
  }

  private async verifyOtpRecord(phone: string, otp: string) {
    const now = new Date();
    const otpRecord = await this.loginOtpRepo.findOne({
      where: {
        phone,
        usedAt: IsNull(),
        invalidatedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
      order: { createdAt: 'DESC' },
    });

    if (!otpRecord || otpRecord.otpHash !== this.hashOtp(otp)) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    await this.loginOtpRepo.update(otpRecord.id, { usedAt: now });
  }

  private validatePhone(phone: string) {
    if (!/^\d{10}$/.test(phone ?? '')) {
      throw new BadRequestException('Please enter a valid 10 digit number');
    }
  }

  private validateEmail(email: string) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '')) {
      throw new BadRequestException('Please enter a valid email');
    }
  }

  private hashOtp(otp: string) {
    const secret =
      this.configService.get<string>('OTP_HASH_SECRET') ??
      this.configService.get<string>('JWT_SECRET') ??
      JWT_SECRET_FALLBACK;

    return createHmac('sha256', secret).update(otp).digest('hex');
  }

  private maskEmail(email: string) {
    const [name, domain] = email.split('@');

    if (!name || !domain) {
      return email;
    }

    const visibleName = name.slice(0, 2);
    return `${visibleName}${'*'.repeat(Math.max(name.length - 2, 2))}@${domain}`;
  }
}
