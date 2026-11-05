// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { EnterpriseApiOutputs, EnterpriseOperationId } from '@mn/contracts/enterprise-client';
import { type ApiInput, type EnterpriseBrowserClient, type MutationTicket } from './client.js';
import { submissionError, useSubmission } from './submission-ui.js';
const labels: Readonly<Record<string, string>> = { createEnterpriseWorkspace: '建立经营主体', inviteOrganizationMember: '创建成员邀请', acceptOrganizationInvitation: '接受企业邀请', commandOrganizationMember: '变更成员状态', grantBusinessRole: '授予业务权限', revokeBusinessRole: '撤销业务权限', createDepartment: '添加部门' };
export function useMutation<K extends EnterpriseOperationId>(api: EnterpriseBrowserClient, operation: K, onSaved: (value: EnterpriseApiOutputs[K]) => void) {
  const [ticket, setTicket] = useState<MutationTicket<K>>(), [error, setError] = useState<unknown>();
  const label = labels[operation] ?? '保存业务配置', submission = useSubmission(label);
  const submit = async (input: ApiInput<K>) => {
    if (submission.chain.snapshot().busy) return;
    setError(undefined);
    try {
      const value = await submission.run(scope => { const pending = ticket ?? api.prepareMutation(operation, input); setTicket(pending); return scope.write({ key: pending.key, label, execute: signal => api.executeMutation(pending, signal) }); });
      if (submission.isMounted()) { setTicket(undefined); onSaved(value); }
    } catch (cause) { if (submission.isMounted()) { setError(submissionError(cause, submission.chain)); if (!submission.chain.snapshot().pendingKey) setTicket(undefined); } }
  };
  return { busy: submission.busy, error, uncertain: submission.uncertain, submit };
}
