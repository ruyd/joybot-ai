import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config } from 'dotenv';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/config/config';

export interface AppOptions {
  /** Extra environment (e.g. AUTH_MODE=cognito with fake pool ids). */
  env?: Record<string, string>;
  /** Provider overrides, e.g. fake JWT verifiers or a fake EmployeeLogins. */
  overrides?: { token: unknown; value: unknown }[];
}

export async function createApp(options: AppOptions = {}): Promise<INestApplication> {
  config({ path: path.resolve(__dirname, '../../../.env') });
  const cfg = loadConfig({ ...process.env, AUTH_MODE: 'dev', NODE_ENV: 'test', ...options.env });
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] });
  for (const o of options.overrides ?? []) builder = builder.overrideProvider(o.token).useValue(o.value);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
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
