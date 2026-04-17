/**
 * Layer 3: A2X Integration - public API.
 * Also registers the default mappers.
 */

export { AgentExecutor, StreamingMode } from './agent-executor.js';
export type { AgentExecutorOptions, RunConfig } from './agent-executor.js';
export { A2XAgent } from './a2x-agent.js';
export type { ProtocolVersion, A2XAgentOptions } from './a2x-agent.js';
export { AgentCardMapperFactory } from './agent-card-mapper.js';
export type { AgentCardMapper } from './agent-card-mapper.js';
export { V03AgentCardMapper } from './v03-mapper.js';
export { V10AgentCardMapper } from './v10-mapper.js';
export { ResponseMapperFactory } from './response-mapper.js';
export type { ResponseMapper } from './response-mapper.js';
export { V03ResponseMapper } from './v03-response-mapper.js';
export { V10ResponseMapper } from './v10-response-mapper.js';
export { InMemoryTaskStore } from './task-store.js';
export type {
  TaskStore,
  CreateTaskParams,
  TaskUpdate,
} from './task-store.js';
export { InMemoryPushNotificationConfigStore } from './push-notification-config-store.js';
export type {
  PushNotificationConfigStore,
} from './push-notification-config-store.js';

// ─── Register default agent-card mappers ───

import { AgentCardMapperFactory } from './agent-card-mapper.js';
import { V03AgentCardMapper } from './v03-mapper.js';
import { V10AgentCardMapper } from './v10-mapper.js';

AgentCardMapperFactory.register('0.3', new V03AgentCardMapper());
AgentCardMapperFactory.register('1.0', new V10AgentCardMapper());

// ─── Register default response mappers ───

import { ResponseMapperFactory } from './response-mapper.js';
import { V03ResponseMapper } from './v03-response-mapper.js';
import { V10ResponseMapper } from './v10-response-mapper.js';

ResponseMapperFactory.register('0.3', new V03ResponseMapper());
ResponseMapperFactory.register('1.0', new V10ResponseMapper());
