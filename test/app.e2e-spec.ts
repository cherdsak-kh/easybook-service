import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { API_BASE_PATH } from './../src/common/api.constants';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

// The pg driver adapter needs a URL to construct. `/health` is now a readiness gate, so
// whether a live DB/Redis is present decides between 200 and 503 — the assertion below
// checks the status code AGREES with the reported breakdown rather than hard-coding 200.
process.env.DATABASE_URL ??=
  'postgresql://user:pass@localhost:5432/easybook_test?schema=public';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix(API_BASE_PATH.replace(/^\//, ''));
    await app.init();
  });

  it(`GET ${API_BASE_PATH}/health → 200 when ready, else 503 (readiness gate)`, () => {
    return request(app.getHttpServer())
      .get(`${API_BASE_PATH}/health`)
      .expect((res) => {
        const body = res.body as {
          status?: string;
          db?: string;
          redis?: string;
        };
        const ready = body.db === 'up' && body.redis === 'up';
        const expectedCode = ready ? 200 : 503;
        if (res.status !== expectedCode) {
          throw new Error(
            `expected HTTP ${expectedCode} for db=${String(body.db)} redis=${String(
              body.redis,
            )}, got ${res.status}`,
          );
        }
        const expectedStatus = ready ? 'ok' : 'error';
        if (body.status !== expectedStatus) {
          throw new Error(
            `expected status '${expectedStatus}', got ${String(body.status)}`,
          );
        }
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
