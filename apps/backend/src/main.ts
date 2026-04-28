import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const port = Number(process.env.PORT ?? 3001);
  const origin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173';
  const isProduction = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';

  // Global validation pipe - reject unknown properties, transform inputs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      forbidNonWhitelisted: true, // reject requests with unknown props
      transform: true, // auto-transform payloads to DTO instances
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });

  app.enableCors({
    origin: origin.split(',').map((value) => value.trim()),
    credentials: true,
  });
  app.setGlobalPrefix('api');

  await app.listen(port);
}

bootstrap();
