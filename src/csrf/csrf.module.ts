import { Global, Module } from '@nestjs/common';
import { CsrfService } from './csrf.service';

/** Global so `main.ts` can `app.get(CsrfService)` and `AuthSystemController` can inject it. */
@Global()
@Module({
  providers: [CsrfService],
  exports: [CsrfService],
})
export class CsrfModule {}
