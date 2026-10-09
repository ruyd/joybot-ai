import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { config as loadEnv } from 'dotenv';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';

async function bootstrap(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, '../../../.env') });
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config));
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

void bootstrap();
