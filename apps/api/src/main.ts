import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { DomainExceptionFilter } from './common/domain-exception.filter'
import { loadEnv } from './config/env'

async function bootstrap(): Promise<void> {
  const env = loadEnv(process.env)
  const app = await NestFactory.create(AppModule)
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true })
  app.useGlobalFilters(new DomainExceptionFilter())
  await app.listen(env.port)
}

void bootstrap()
