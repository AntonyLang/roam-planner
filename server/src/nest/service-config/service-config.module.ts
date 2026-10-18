import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InternalServiceConfigController, ServiceConfigController } from './service-config.controller';
import { ServiceConfigService } from './service-config.service';
@Module({ imports: [DatabaseModule], controllers: [ServiceConfigController, InternalServiceConfigController], providers: [ServiceConfigService] })
export class ServiceConfigModule {}
