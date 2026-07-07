import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_BASE_PATH } from './common/api.constants';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true preserves req.rawBody so the LINE webhook signature can be
  // verified (HMAC over the exact bytes) even after JSON parsing.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);

  // Versioned API surface — single source of truth lives in @easy-book/contracts.
  app.setGlobalPrefix(API_BASE_PATH.replace(/^\//, ''));

  // DTO-driven validation at the transport boundary.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Frontend and backend are separate origins by design.
  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN', 'http://localhost:2200'),
    credentials: true,
  });

  // OpenAPI / Swagger UI at /docs (raw spec at /docs-json). Can be disabled in prod.
  if (config.get<string>('SWAGGER_ENABLED', 'true') !== 'false') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('EasyBook API')
      .setDescription('REST contract for the EasyBook booking service.')
      .setVersion('v1')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  const port = config.get<number>('PORT', 3300);
  await app.listen(port);
}

void bootstrap();
