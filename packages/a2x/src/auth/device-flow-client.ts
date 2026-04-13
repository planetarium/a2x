/**
 * DeviceFlowClient - Phase 3 stub.
 * This file serves as the entry point for the a2x/auth subpath export.
 */

import type { Task } from '../types/task.js';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import type { SendMessageParams } from '../types/jsonrpc.js';

// ─── Device Flow Types ───

export interface DeviceFlowClientOptions {
  agentCardUrl: string;
  clientId?: string;
  fetch?: typeof globalThis.fetch;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  refreshToken?: string;
  scope?: string;
}

// ─── DeviceFlowClient ───

export class DeviceFlowClient {
  private readonly options: DeviceFlowClientOptions;

  constructor(options: DeviceFlowClientOptions) {
    this.options = options;
  }

  async requestDeviceCode(
    _params: { scope?: string },
  ): Promise<DeviceCodeResponse> {
    throw new Error('DeviceFlowClient not yet implemented (Phase 3)');
  }

  async pollForToken(
    _deviceCode: string,
    _options?: { timeout?: number },
  ): Promise<TokenResponse> {
    throw new Error('DeviceFlowClient not yet implemented (Phase 3)');
  }

  createAuthenticatedClient(
    _token: TokenResponse,
  ): AuthenticatedA2AClient {
    throw new Error('DeviceFlowClient not yet implemented (Phase 3)');
  }
}

// ─── AuthenticatedA2AClient ───

export class AuthenticatedA2AClient {
  constructor(
    _baseUrl: string,
    _token: TokenResponse,
  ) {
    // Phase 3
  }

  async send(_params: SendMessageParams): Promise<Task> {
    throw new Error('AuthenticatedA2AClient not yet implemented (Phase 3)');
  }

  async *stream(
    _params: SendMessageParams,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    throw new Error('AuthenticatedA2AClient not yet implemented (Phase 3)');
  }

  async getTask(_taskId: string): Promise<Task> {
    throw new Error('AuthenticatedA2AClient not yet implemented (Phase 3)');
  }

  async cancelTask(_taskId: string): Promise<Task> {
    throw new Error('AuthenticatedA2AClient not yet implemented (Phase 3)');
  }
}
