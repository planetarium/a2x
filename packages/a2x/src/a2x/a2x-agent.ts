/**
 * Layer 3: A2XAgent - the main integration class that bridges
 * the agent system with the A2A protocol.
 */

import type { LlmAgent } from '../agent/llm-agent.js';
import type { BaseSecurityScheme } from '../security/base.js';
import type { AgentExtension, AgentProvider } from '../types/common.js';
import type {
  A2XAgentSkill,
  A2XAgentState,
  A2XInterfaceEntry,
  AgentCardV03,
  AgentCardV10,
} from '../types/agent-card.js';
import type { SecurityRequirement } from '../types/security.js';
import type { AuthResult } from '../types/auth.js';
import { AuthenticatedExtendedCardNotConfiguredError } from '../types/errors.js';
import { AgentExecutor, StreamingMode } from './agent-executor.js';
import { AgentCardMapperFactory } from './agent-card-mapper.js';
import type { TaskStore } from './task-store.js';
import type { PushNotificationConfigStore } from './push-notification-config-store.js';
import type { PushNotificationSender } from './push-notification-sender.js';
import type { TaskEventBus } from './task-event-bus.js';
import { InMemoryTaskEventBus } from './task-event-bus.js';

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
  pushNotificationConfigStore?: PushNotificationConfigStore;
  /**
   * Optional webhook delivery for `tasks/pushNotificationConfig/*`.
   * Without it, `capabilities.pushNotifications` defaults to `false`
   * even when a config store is wired — advertising the capability
   * without delivery would falsely promise webhook callbacks. See
   * issue #119.
   */
  pushNotificationSender?: PushNotificationSender;
  taskEventBus?: TaskEventBus;
}

export class A2XAgent {
  private readonly _taskStore: TaskStore;
  private readonly _agentExecutor: AgentExecutor;
  private readonly _protocolVersion: ProtocolVersion;
  private readonly _pushNotificationConfigStore?: PushNotificationConfigStore;
  private readonly _pushNotificationSender?: PushNotificationSender;
  private readonly _taskEventBus: TaskEventBus;

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
  private _authenticatedExtendedCardProvider?: (
    authResult: AuthResult,
  ) => Partial<A2XAgentState> | Promise<Partial<A2XAgentState>>;

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
    this._pushNotificationConfigStore = options.pushNotificationConfigStore;
    this._pushNotificationSender = options.pushNotificationSender;
    this._taskEventBus = options.taskEventBus ?? new InMemoryTaskEventBus();
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

  /**
   * @deprecated Use the focused builder methods instead:
   *   - `addExtension(ext)` for `capabilities.extensions` (append-only, no clobber).
   *   - `setPushNotifications(enabled)` to force-set the flag; by default it's
   *     derived from whether `pushNotificationConfigStore` was provided to the
   *     constructor.
   *   - `setStateTransitionHistory(enabled)` for the v0.3-only flag.
   *   - `streaming` is already auto-extracted from `runConfig.streamingMode`
   *     and needs no manual setter.
   *   - `extendedAgentCard` is already auto-set by
   *     `setAuthenticatedExtendedCardProvider()`.
   *
   * This method will be removed in the next major. While it coexists with the
   * replacements, `setCapabilities({ extensions: [...] })` appends (same
   * semantics as `addExtension`) rather than overwriting, so calls from
   * multiple sources no longer clobber one another.
   */
  setCapabilities(capabilities: Partial<A2XAgentState['capabilities']>): this {
    const { extensions, ...rest } = capabilities;
    this._capabilities = { ...this._capabilities, ...rest };
    if (extensions && extensions.length > 0) {
      const existing = this._capabilities.extensions ?? [];
      this._capabilities.extensions = [...existing, ...extensions];
    }
    this._invalidateCache();
    return this;
  }

  /**
   * Append an extension to `capabilities.extensions`.
   *
   * Extensions are A2A-level capability declarations keyed by URI (e.g. the
   * a2a-x402 payment extension). `addExtension` is append-only — calling it
   * repeatedly never drops a previously added extension.
   *
   * Two call shapes:
   * - `addExtension({ uri, description?, required?, params? })`
   * - `addExtension(uri, { description?, required?, params? })`
   */
  addExtension(extension: AgentExtension): this;
  addExtension(
    uri: string,
    options?: Omit<AgentExtension, 'uri'>,
  ): this;
  addExtension(
    extensionOrUri: AgentExtension | string,
    options?: Omit<AgentExtension, 'uri'>,
  ): this {
    const extension: AgentExtension =
      typeof extensionOrUri === 'string'
        ? { uri: extensionOrUri, ...(options ?? {}) }
        : extensionOrUri;
    const existing = this._capabilities.extensions ?? [];
    this._capabilities = {
      ...this._capabilities,
      extensions: [...existing, extension],
    };
    this._invalidateCache();
    return this;
  }

  /**
   * Force the `capabilities.pushNotifications` flag. Rarely needed — the
   * flag defaults to `true` when the constructor receives a
   * `pushNotificationConfigStore` and `false` otherwise. Call this only to
   * override the derived value (e.g. advertise the capability before wiring
   * the store, or suppress it when the store is present but unused).
   */
  setPushNotifications(enabled: boolean): this {
    this._capabilities = {
      ...this._capabilities,
      pushNotifications: enabled,
    };
    this._invalidateCache();
    return this;
  }

  /**
   * Advertise support for returning historical task state transitions on
   * `tasks/get` / `tasks/resubscribe`. Only part of the v0.3 AgentCard —
   * v1.0 does not expose the flag and it is silently dropped from v1.0 cards.
   */
  setStateTransitionHistory(enabled: boolean): this {
    this._capabilities = {
      ...this._capabilities,
      stateTransitionHistory: enabled,
    };
    this._invalidateCache();
    return this;
  }

  /**
   * Register a provider that enriches the AgentCard for authenticated users.
   *
   * When set, the JSON-RPC method `agent/getAuthenticatedExtendedCard`
   * becomes available. The provider is invoked with the resolved AuthResult
   * and returns a Partial<A2XAgentState> overlay that is merged on top of
   * the base state before mapping to the target protocol version.
   *
   * Automatically advertises the capability on the base AgentCard:
   *   - v0.3: `supportsAuthenticatedExtendedCard: true`
   *   - v1.0: `capabilities.extendedAgentCard: true`
   */
  setAuthenticatedExtendedCardProvider(
    provider: (
      authResult: AuthResult,
    ) => Partial<A2XAgentState> | Promise<Partial<A2XAgentState>>,
  ): this {
    this._authenticatedExtendedCardProvider = provider;
    this._supportsAuthenticatedExtendedCard = true;
    this._capabilities = { ...this._capabilities, extendedAgentCard: true };
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

  get securitySchemes(): ReadonlyMap<string, BaseSecurityScheme> {
    return this._securitySchemes;
  }

  get securityRequirements(): readonly SecurityRequirement[] {
    return this._securityRequirements;
  }

  /**
   * Read-only view of declared A2A extensions. Transports use this to
   * enforce the a2a-x402 v0.2 §8 `X-A2A-Extensions` activation header
   * check for any extension declared with `required: true`.
   */
  get extensions(): readonly AgentExtension[] {
    return this._capabilities.extensions ?? [];
  }

  get pushNotificationConfigStore(): PushNotificationConfigStore | undefined {
    return this._pushNotificationConfigStore;
  }

  get pushNotificationSender(): PushNotificationSender | undefined {
    return this._pushNotificationSender;
  }

  get taskEventBus(): TaskEventBus {
    return this._taskEventBus;
  }

  get hasAuthenticatedExtendedCardProvider(): boolean {
    return this._authenticatedExtendedCardProvider !== undefined;
  }

  /**
   * Build the authenticated extended AgentCard.
   *
   * Throws `AuthenticatedExtendedCardNotConfiguredError` if no provider
   * has been registered. Does NOT perform authentication itself — the
   * caller is responsible for passing an authenticated AuthResult.
   */
  async getAuthenticatedExtendedCard(
    authResult: AuthResult,
    version?: string,
  ): Promise<AgentCardV03 | AgentCardV10> {
    const provider = this._authenticatedExtendedCardProvider;
    if (!provider) {
      throw new AuthenticatedExtendedCardNotConfiguredError();
    }

    const baseState = this._buildState();
    const overlay = await provider(authResult);

    // Shallow merge for top-level fields; deep merge for capabilities and
    // arrays (skills, interfaces, securityRequirements) are replaced wholesale
    // by the overlay when present. This keeps semantics simple and predictable.
    const mergedState: A2XAgentState = {
      ...baseState,
      ...overlay,
      capabilities: {
        ...baseState.capabilities,
        ...(overlay.capabilities ?? {}),
      },
      // If overlay supplies securitySchemes (rare), merge Maps; otherwise keep base.
      securitySchemes: overlay.securitySchemes
        ? new Map([...baseState.securitySchemes, ...overlay.securitySchemes])
        : baseState.securitySchemes,
    };

    if (!mergedState.name) {
      throw new Error(
        'A2XAgent.getAuthenticatedExtendedCard: name is required on the merged state',
      );
    }
    if (!mergedState.description) {
      throw new Error(
        'A2XAgent.getAuthenticatedExtendedCard: description is required on the merged state',
      );
    }

    const resolvedVersion = version ?? this._protocolVersion;
    const mapper = AgentCardMapperFactory.getMapper(resolvedVersion);
    return mapper.map(mergedState) as AgentCardV03 | AgentCardV10;
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

    // Auto-derive push-notification capability. The flag promises
    // webhook delivery (spec a2a-v0.3 §AgentCapabilities.pushNotifications:
    // "supports sending push notifications"), so it only flips to true
    // when a `PushNotificationSender` is wired AND a config store is
    // available — both are needed for an actual end-to-end delivery.
    // Without the sender, advertising the capability would be a false
    // promise (the SDK would accept config-management calls but never
    // POST to the configured URL). See issue #119.
    //
    // An explicit value set via setPushNotifications() or the
    // deprecated setCapabilities() still wins.
    const pushNotifications =
      this._capabilities.pushNotifications ??
      (this._pushNotificationConfigStore !== undefined &&
        this._pushNotificationSender !== undefined);

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
        pushNotifications,
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
