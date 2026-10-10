// SPDX-License-Identifier: Apache-2.0
import type { GoalScope } from './goals.js';
import { hostTeamTemplates, type HostTeamRuntimeOptions } from './team-planning.js';
import type { TeamSkillServiceOptions } from './team-skills.js';
import { createHostTeamRuntime } from './team-runtime.js';
import { validateHostContextSource, validateHistoricalHostContextSource } from './context-source-validation.js';
export function createHostTeamSkillOptions(options: HostTeamRuntimeOptions, scope: GoalScope): TeamSkillServiceOptions {
  const runtime = createHostTeamRuntime({ ...options, validateContextSource: validateHistoricalHostContextSource });
  return { ...options, ...scope, ports: {
    validateContextSource: validateHostContextSource,
    isTemplateAvailable: (tx, selected, skill) => hostTeamTemplates(options, tx, selected.tenantId, selected.workspaceId).some(template => template.id === skill.template.id && template.available),
    assertDelivery(tx, _scope, source) { runtime.assertDelivery(tx, source); },
  } };
}
