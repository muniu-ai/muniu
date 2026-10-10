// SPDX-License-Identifier: Apache-2.0
import {createGoalOutputReader} from './goal-output-access.js';
import {createHostGoalRuntime,type HostGoalRuntimeOptions} from './goal-runtime.js';
import {createHostTeamRuntime} from './team-runtime.js';
import {isCoordinatedGoalPlan} from '@mn/contracts';
import {validateHistoricalHostContextSource} from './context-source-validation.js';
import type {GoalExportOptions} from './goal-exports.js';
export function createHostGoalExportRuntime(options:HostGoalRuntimeOptions & {readonly sandboxAvailable?:boolean}):Pick<GoalExportOptions,'ports'|'validateContextSource'>{
 const scoped={...options,validateContextSource:validateHistoricalHostContextSource};
 const reader=createGoalOutputReader({assertDelivery(tx,context){if(isCoordinatedGoalPlan(context.plan))createHostTeamRuntime(scoped).assertDelivery(tx,{...context,plan:context.plan});else createHostGoalRuntime(scoped).assertDelivery(tx,{...context,plan:context.plan});}});
 return {validateContextSource:validateHistoricalHostContextSource,ports:{readOutput:(tx,scope,origin)=>reader.readOutput(tx,scope,origin,'read')}};
}
