// SPDX-License-Identifier: Apache-2.0
import { EnterpriseError } from '@mn/enterprise-services';
import { findModelPrice } from '@mn/kernel';
import type { EvaluationModel } from './enterprise-evaluation.js';
export function checkedEnterpriseModel(model: EvaluationModel | undefined): EvaluationModel {
    if (!model) throw new EnterpriseError('MODEL_CONNECTION_UNCONFIGURED', 409);
    if (!model.id || !Number.isSafeInteger(model.version) || model.version < 1 || !['openai', 'deepseek', 'anthropic', 'moonshot', 'qwen'].includes(model.providerId) || !model.modelId
      || !(/^env:\/\/muniu\.enterprise\/MN_ENTERPRISE_MODEL_[A-Z0-9_]+$/u.test(model.secretRef) || model.secretRef.startsWith('keychain://muniu.enterprise/') || model.secretRef.startsWith('vault://muniu.enterprise/') || (model.mode === 'test_fixture' && model.secretRef.startsWith('fixture://enterprise/')))) throw new EnterpriseError('MODEL_CONNECTION_INVALID', 409);
    const price = findModelPrice(model.providerId, model.modelId);
    if (model.mode === 'live' && (!price || price.rates.currency !== 'CNY')) throw new EnterpriseError('MODEL_PRICE_UNAVAILABLE', 409);
    return structuredClone(model);
}
