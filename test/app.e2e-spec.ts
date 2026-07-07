import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { API_BASE_PATH } from './../src/common/api.constants';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

// The pg driver adapter needs a URL to construct; a real DB is not required
// (connection failures degrade to db: "down").
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

  it(`GET ${API_BASE_PATH}/health → 200 ok`, () => {
    return request(app.getHttpServer())
      .get(`${API_BASE_PATH}/health`)
      .expect(200)
      .expect((res) => {
        if (res.body.status !== 'ok') {
          throw new Error(`expected status 'ok', got ${res.body.status}`);
        }
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
