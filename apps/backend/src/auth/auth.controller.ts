import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  async login(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(body.email, body.password);
    response.cookie(this.cookieName(), result.accessToken, this.cookieOptions());
    return { user: result.user };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: { user: { sub: string; email: string; role: string } }) {
    return req.user;
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(this.cookieName(), this.cookieOptions());
    return { ok: true };
  }

  private cookieName() {
    return 'crm_session';
  }

  private cookieOptions() {
    const secureCookie = this.config.get<string>('AUTH_COOKIE_SECURE') === 'true';
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: secureCookie,
      path: '/',
      maxAge: 8 * 60 * 60 * 1000,
    };
  }
}
