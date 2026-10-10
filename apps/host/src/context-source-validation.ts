// SPDX-License-Identifier: Apache-2.0
import type { ContextSourceValidator } from '@mn/worker';
import { validateHostMemoryContextSource } from './memory-sources.js';
import { validateTeamSkillContextSource } from './team-skill-context.js';
import { validateBusinessContextSource, validateHistoricalBusinessContextSource } from './business-context.js';
export const validateHostContextSource: ContextSourceValidator = (tx, scope, ref) => {
  validateHostMemoryContextSource(tx, scope, ref);
  return validateTeamSkillContextSource(tx, scope, ref) || validateBusinessContextSource(tx, scope, ref);
};
export const validateHistoricalHostContextSource: ContextSourceValidator = (tx, scope, ref) => {
  validateHostMemoryContextSource(tx, scope, ref);
  return validateTeamSkillContextSource(tx, scope, ref) || validateHistoricalBusinessContextSource(tx, scope, ref);
};
