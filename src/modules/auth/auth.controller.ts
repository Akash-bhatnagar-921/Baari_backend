import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/auth.dto';
import {
  RequestLoginOtpDto,
  RequestRegisterOtpDto,
  VerifyLoginOtpDto,
  VerifyRegisterOtpDto,
} from './dto/login-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Get('check-phone')
  checkPhone(@Query('phone') phone: string) {
    return this.authService.checkPhone(phone);
  }

  @Post('register')
  register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: { phone: string }) {
    return this.authService.login(body.phone);
  }

  @Post('login/request-otp')
  @HttpCode(200)
  requestLoginOtp(@Body() body: RequestLoginOtpDto) {
    return this.authService.requestLoginOtp(body.phone);
  }

  @Post('login/verify-otp')
  @HttpCode(200)
  verifyLoginOtp(@Body() body: VerifyLoginOtpDto) {
    return this.authService.verifyLoginOtp(body.phone, body.otp);
  }

  @Post('register/request-otp')
  @HttpCode(200)
  requestRegisterOtp(@Body() body: RequestRegisterOtpDto) {
    return this.authService.requestRegisterOtp(body.phone, body.email);
  }

  @Post('register/verify-otp')
  @HttpCode(200)
  verifyRegisterOtp(@Body() body: VerifyRegisterOtpDto) {
    return this.authService.verifyRegisterOtp(body);
  }
}
