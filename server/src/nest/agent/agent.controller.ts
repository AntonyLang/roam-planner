import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { agentAdoptSchema, agentConditionsSchema } from '@trek/shared';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../../types';
import { AgentService } from './agent.service';
import { AgentDrafts } from './agent-drafts.service';

class AdoptDto extends createZodDto(agentAdoptSchema) {}
class ConditionsDto extends createZodDto(agentConditionsSchema) {}
class DraftEditDto extends createZodDto(z.object({ base_version:z.number().int().nonnegative(), patches:z.array(z.record(z.string(),z.unknown())), remove_refs:z.array(z.string()), order:z.array(z.string()).optional() }).strict()) {}
const routePointSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), coordinate_system: z.literal('WGS84') });
export class MapRouteDto extends createZodDto(z.object({ origin: routePointSchema, destination: routePointSchema, mode: z.enum(['walking','transit','driving']) }).strict()) {}
export class ConfirmationDto extends createZodDto(z.object({key:z.string().min(1).max(8000)}).strict()) {}

@Controller('api/agent')
export class AgentController {
  constructor(private readonly service: AgentService, private readonly drafts: AgentDrafts) {}
  @Get('trips/:id/snapshot') snapshot(@Param('id') id: string, @CurrentUser() user: User) { return this.service.snapshot(Number(id), user.id); }
  @Put('trips/:id/conditions') conditions(@Param('id') id: string, @CurrentUser() user: User, @Body() body: ConditionsDto) { return this.service.conditions(Number(id), user.id, body.requirements); }
  @Get('trips/:id/candidates') candidates(@Param('id') id: string, @CurrentUser() user: User) { return { candidates: this.service.list(Number(id), user.id) }; }
  @Post('trips/:id/routes') route(@Param('id') id: string, @CurrentUser() user: User, @Body() body: MapRouteDto) { return this.service.mapRoute(Number(id), user.id, body); }
  @Get('trips/:id/confirmations') confirmations(@Param('id') id:string,@CurrentUser() user:User){return this.service.confirmations(Number(id),user.id);}
  @Post('trips/:id/confirmations') confirm(@Param('id') id:string,@CurrentUser() user:User,@Body() body:ConfirmationDto){return this.service.confirm(Number(id),user.id,body.key);}
  @Post('candidates/:id/adopt') adopt(@Param('id') id: string, @CurrentUser() user: User, @Body() body: AdoptDto) { return this.service.adopt(id, body.candidate_version, body.operation_id, user.id); }
  @Get('drafts/:sessionId') draft(@Param('sessionId') sessionId: string, @CurrentUser() user: User) { return this.drafts.read(sessionId, user.id); }
  @Put('drafts/:sessionId') editDraft(@Param('sessionId') sessionId: string, @CurrentUser() user: User, @Body() body: DraftEditDto) { return this.drafts.editPage(sessionId, user.id, body); }
}
