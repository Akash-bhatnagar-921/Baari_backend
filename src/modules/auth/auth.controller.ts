import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  register(
    @Body()
    body: {
      phone: string;
      role: string;
      hasAcceptedTerms: boolean;
    },
  ) {
    return this.authService.register(
      body.phone,
      body.role,
      body.hasAcceptedTerms,
    );
  }

  @Post('login')
  login(@Body() body: { phone: string }) {
    return this.authService.login(body.phone);
  }
}
