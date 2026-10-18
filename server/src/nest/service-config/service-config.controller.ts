import { Body, Controller, Get, Headers, Param, Post, Put, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { ServiceConfigService } from './service-config.service';
import { ServiceCheckDto, ServiceConfigDto } from './service-config.dto';
@Controller('api/services')
@UseGuards(JwtAuthGuard)
export class ServiceConfigController {
  constructor(private readonly service: ServiceConfigService) {}
  @Get('config') read() { return this.service.read(); }
  @Put('config') @UseGuards(AdminGuard) save(@Body() input: ServiceConfigDto) { return this.service.save(input); }
  @Post('check') @UseGuards(AdminGuard) check(@Body() input: ServiceCheckDto) { return this.service.check(input.service, input.config); }
  @Post('complete') @UseGuards(AdminGuard) complete() { return this.service.complete(); }
  @Post('skip') @UseGuards(AdminGuard) skip() { return this.service.skip(); }
  @Get('xhs/status') xhsStatus() { return this.service.xhs('status'); }
  @Post('xhs/login') @UseGuards(AdminGuard) xhsLogin() { return this.service.xhs('login'); }
  @Post('xhs/logout') @UseGuards(AdminGuard) xhsLogout() { return this.service.xhs('logout'); }
}
@Controller('api/services/internal')
@Public('Private container configuration authenticated by the service token, not a browser session')
export class InternalServiceConfigController {
  constructor(private readonly service: ServiceConfigService) {}
  @Get(':kind') read(@Param('kind') kind: string, @Headers('x-roam-service-token') token: string) {
    this.service.authenticate(token); return this.service.internal(kind);
  }
}
