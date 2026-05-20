import { registerApprovalHandler } from '../approvals/index.js';
import { applyInfraFix } from './apply.js';

registerApprovalHandler('infra_fix', applyInfraFix);
