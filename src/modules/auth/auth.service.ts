import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/user.entity';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async register(phone: string, role: string, hasAcceptedTerms: boolean) {
    if (!hasAcceptedTerms) {
      throw new Error('You must accept terms and conditions');
    }

    const existingUser = await this.usersService.findByPhone(phone);

    if (existingUser) {
      throw new Error('User already exists');
    }

    const user = await this.usersService.createUser(phone, role as any);

    // update terms info
    await this.usersService.updateProfile(user.id, {
      hasAcceptedTerms: true,
      termsAcceptedAt: new Date(),
      termsVersion: 'v1',
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

  async login(phone: string) {
    const user = await this.usersService.findByPhone(phone);

    if (!user) {
      throw new Error('User not found');
    }

    const payload = {
      sub: user.id,
      phone: user.phone,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user,
    };
  }
}
