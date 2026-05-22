import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JWT_SECRET_FALLBACK } from '../jwt.constants';

type JwtPayload = {
  sub: string;
  phone: string;
  role?: string;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey:
        configService.get<string>('JWT_SECRET') ?? JWT_SECRET_FALLBACK,
    });
  }

  validate(payload: JwtPayload) {
    return {
      userId: payload.sub,
      phone: payload.phone,
      role: payload.role,
    };
  }
}
