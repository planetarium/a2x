/**
 * Layer 3: A2XAgent - the main integration class that bridges
 * the agent system with the A2A protocol.
 */

import type { LlmAgent } from '../agent/llm-agent.js';
import type { BaseSecurityScheme } from '../security/base.js';
import type { AgentProvider } from '../types/common.js';
import type {
  A2XAgentSkill,
  A2XAgentState,
  A2XInterfaceEntry,
  AgentCardV03,
  AgentCardV10,
} from '../types/agent-card.js';
import type { SecurityRequirement } from '../types/security.js';
import { AgentExecutor, StreamingMode } from './agent-executor.js';
import { AgentCardMapperFactory } from './agent-card-mapper.js';
import type { TaskStore } from './task-store.js';

// ─── Protocol Version ───

export type ProtocolVersion = '0.3' | '1.0';

const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set<string>([
  '0.3',
  '1.0',
]);

export interface A2XAgentOptions {
  taskStore: TaskStore;
  executor: AgentExecutor;
  protocolVersion?: ProtocolVersion;
}

export class A2XAgent {
  private readonly _taskStore: TaskStore;
  private readonly _agentExecutor: AgentExecutor;
  private readonly _protocolVersion: ProtocolVersion;

  // ─── Internal mutable state (builder pattern) ───
  private _name?: string;
  private _description?: string;
  private _version?: string;
  private _defaultUrl?: string;
  private _interfaces: A2XInterfaceEntry[] = [];
  private _provider?: AgentProvider;
  private _capabilities: A2XAgentState['capabilities'] = {};
  private _securitySchemes = new Map<string, BaseSecurityScheme>();
  private _securityRequirements: SecurityRequirement[] = [];
  private _skills: A2XAgentSkill[] = [];
  private _defaultInputModes: string[] = ['text/plain'];
  private _defaultOutputModes: string[] = ['text/plain'];
  private _documentationUrl?: string;
  private _iconUrl?: string;
  private _supportsAuthenticatedExtendedCard?: boolean;

  // ─── AgentCard cache ───
  private _cardCache = new Map<string, AgentCardV03 | AgentCardV10>();

  constructor(options: A2XAgentOptions) {
    if (!options.taskStore) {
      throw new Error('A2XAgent: taskStore is required');
    }
    if (!options.executor) {
      throw new Error('A2XAgent: executor is required');
    }
    if (
      options.protocolVersion !== undefined &&
      !SUPPORTED_PROTOCOL_VERSIONS.has(options.protocolVersion)
    ) {
      throw new Error(
        `A2XAgent: unsupported protocolVersion '${options.protocolVersion}'. Supported versions: ${Array.from(SUPPORTED_PROTOCOL_VERSIONS).join(', ')}`,
      );
    }

    this._taskStore = options.taskStore;
    this._agentExecutor = options.executor;
    this._protocolVersion = options.protocolVersion ?? '1.0';
  }

  // ─── Builder Methods (return this for chaining) ───

  setName(name: string): this {
    this._name = name;
    this._invalidateCache();
    return this;
  }

  setDescription(description: string): this {
    this._description = description;
    this._invalidateCache();
    return this;
  }

  setVersion(version: string): this {
    this._version = version;
    this._invalidateCache();
    return this;
  }

  setDefaultUrl(url: string): this {
    if (!url || url.trim() === '') {
      throw new Error('A2XAgent.setDefaultUrl: url must not be empty');
    }
    this._defaultUrl = url;
    this._invalidateCache();
    return this;
  }

  addSkill(skill: A2XAgentSkill): this {
    this._skills.push(skill);
    this._invalidateCache();
    return this;
  }

  addSecurityScheme(name: string, scheme: BaseSecurityScheme): this {
    if (this._securitySchemes.has(name)) {
      console.warn(
        `A2XAgent.addSecurityScheme: overwriting existing scheme '${name}'`,
      );
    }
    this._securitySchemes.set(name, scheme);
    this._invalidateCache();
    return this;
  }

  addSecurityRequirement(requirement: SecurityRequirement): this {
    this._securityRequirements.push(requirement);
    this._invalidateCache();
    return this;
  }

  addInterface(iface: A2XInterfaceEntry): this {
    if (!iface.url || !iface.protocol) {
      throw new Error(
        'A2XAgent.addInterface: url and protocol are required',
      );
    }
    this._interfaces.push(iface);
    this._invalidateCache();
    return this;
  }

  setProvider(provider: AgentProvider): this {
    this._provider = provider;
    this._invalidateCache();
    return this;
  }

  setDefaultInputModes(modes: string[]): this {
    this._defaultInputModes = modes;
    this._invalidateCache();
    return this;
  }

  setDefaultOutputModes(modes: string[]): this {
    this._defaultOutputModes = modes;
    this._invalidateCache();
    return this;
  }

  setDocumentationUrl(url: string): this {
    this._documentationUrl = url;
    this._invalidateCache();
    return this;
  }

  setIconUrl(url: string): this {
    this._iconUrl = url;
    this._invalidateCache();
    return this;
  }

  setCapabilities(capabilities: Partial<A2XAgentState['capabilities']>): this {
    this._capabilities = { ...this._capabilities, ...capabilities };
    this._invalidateCache();
    return this;
  }

  // ─── Core Method ───

  getAgentCard(version?: string): AgentCardV03 | AgentCardV10 {
    const resolvedVersion = version ?? this._protocolVersion;

    // Check cache
    const cached = this._cardCache.get(resolvedVersion);
    if (cached) {
      return cached;
    }

    // Build the internal normalized state
    const state = this._buildState();

    // Validate required fields
    if (!state.name) {
      throw new Error(
        'A2XAgent.getAgentCard: name is required. Use setName() or ensure the agent has a name.',
      );
    }
    if (!state.description) {
      throw new Error(
        'A2XAgent.getAgentCard: description is required. Use setDescription() or ensure the agent has a description.',
      );
    }

    // Validate security requirements reference existing schemes
    for (const req of state.securityRequirements) {
      for (const schemeName of Object.keys(req)) {
        if (!state.securitySchemes.has(schemeName)) {
          throw new Error(
            `A2XAgent.getAgentCard: security requirement references unregistered scheme '${schemeName}'`,
          );
        }
      }
    }

    // Validate skill security requirements
    for (const skill of state.skills) {
      if (skill.securityRequirements) {
        for (const req of skill.securityRequirements) {
          for (const schemeName of Object.keys(req)) {
            if (!state.securitySchemes.has(schemeName)) {
              throw new Error(
                `A2XAgent.getAgentCard: skill '${skill.id}' security requirement references unregistered scheme '${schemeName}'`,
              );
            }
          }
        }
      }
    }

    // Map to the requested version
    const mapper = AgentCardMapperFactory.getMapper(resolvedVersion);
    const card = mapper.map(state);

    // Cache the result
    this._cardCache.set(resolvedVersion, card as AgentCardV03 | AgentCardV10);

    return card as AgentCardV03 | AgentCardV10;
  }

  // ─── Accessors ───

  get protocolVersion(): ProtocolVersion {
    return this._protocolVersion;
  }

  get taskStore(): TaskStore {
    return this._taskStore;
  }

  get agentExecutor(): AgentExecutor {
    return this._agentExecutor;
  }

  // ─── Private Methods ───

  private _invalidateCache(): void {
    this._cardCache.clear();
  }

  /**
   * Build the internal A2XAgentState by:
   * 1. Auto-extracting from agentExecutor internals
   * 2. Applying explicit overrides
   * 3. Applying defaults
   */
  private _buildState(): A2XAgentState {
    const agent = this._agentExecutor.runner.agent;

    // Auto-extract name
    const name = this._name ?? agent.name;

    // Auto-extract description
    let description = this._description ?? agent.description;
    if (!description && 'instruction' in agent) {
      // Try to extract first sentence from instruction
      const llmAgent = agent as LlmAgent;
      if (typeof llmAgent.instruction === 'string') {
        const firstSentence = llmAgent.instruction.split(/[.!?]/)[0];
        if (firstSentence && firstSentence.length > 0) {
          description = firstSentence.trim();
        }
      }
    }

    // Auto-extract streaming capability
    const streaming =
      this._capabilities.streaming ??
      this._agentExecutor.runConfig.streamingMode === StreamingMode.SSE;

    return {
      name,
      description,
      version: this._version ?? '1.0.0',
      defaultUrl: this._defaultUrl,
      interfaces: [...this._interfaces],
      provider: this._provider,
      capabilities: {
        ...this._capabilities,
        streaming,
      },
      securitySchemes: new Map(this._securitySchemes),
      securityRequirements: [...this._securityRequirements],
      skills: [...this._skills],
      defaultInputModes: [...this._defaultInputModes],
      defaultOutputModes: [...this._defaultOutputModes],
      documentationUrl: this._documentationUrl,
      iconUrl: this._iconUrl,
      supportsAuthenticatedExtendedCard:
        this._supportsAuthenticatedExtendedCard,
    };
  }
}
