import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PlacesModule } from '../places/places.module';
import { AssignmentsDomainModule } from '../assignments/assignments-domain.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AgentService } from './agent.service';
import { AgentMcp } from './agent.mcp';
import { AgentController } from './agent.controller';
import { NativeAgentController } from './native-agent.controller';
import { AgentJournal } from './agent-journal.service';
import { AgentDrafts } from './agent-drafts.service';
import { DayNotesModule } from '../day-notes/day-notes.module';
import { BudgetModule } from '../budget/budget.module';
import { AccommodationsDomainModule } from '../accommodations/accommodations-domain.module';
import {ReservationsModule} from '../reservations/reservations.module';
@Module({ imports: [DatabaseModule, PlacesModule, AssignmentsDomainModule, PermissionsModule, DayNotesModule, BudgetModule, AccommodationsDomainModule,ReservationsModule], controllers: [AgentController, NativeAgentController], providers: [AgentService, AgentDrafts, AgentMcp, AgentJournal] })
export class AgentModule {}
