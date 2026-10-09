import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config } from 'dotenv';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/config/config';

export async function createApp(): Promise<INestApplication> {
  config({ path: path.resolve(__dirname, '../../../.env') });
  const cfg = loadConfig({ ...process.env, AUTH_MODE: 'dev', NODE_ENV: 'test' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

type Who = { type: 'employee' | 'customer'; id: string };

/** supertest agent that authenticates as `who` with the local dev header. */
export function api(app: INestApplication, who: Who) {
  const header = `${who.type}:${who.id}`;
  const server = app.getHttpServer();
  return {
    get: (url: string) => request(server).get(url).set('x-dev-principal', header),
    post: (url: string, body?: object) => request(server).post(url).set('x-dev-principal', header).send(body),
    put: (url: string, body?: object) => request(server).put(url).set('x-dev-principal', header).send(body),
  };
}

export const employee = (id: string): Who => ({ type: 'employee', id });
export const customer = (id: string): Who => ({ type: 'customer', id });
