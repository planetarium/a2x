/**
 * a2x SDK - Main entry point
 *
 * A2A (Agent-to-Agent) protocol SDK for TypeScript.
 * Self-contained implementation without ADK or @a2a-js/sdk dependencies.
 */

// Layer 1: Types & Schema
export * from './types/index.js';

// Layer 1: SecurityScheme classes
export * from './security/index.js';

// Layer 2: Agent
export * from './agent/index.js';

// Layer 2: Tool
export * from './tool/index.js';

// Layer 2: Runner & Session
export * from './runner/index.js';

// Layer 2: Plugin
export * from './plugin/index.js';

// Layer 2: Provider (base only — concrete providers via separate entry points)
export * from './provider/index.js';

// Layer 2: Skill runtime (Claude Agent Skills open standard).
// Selective re-export only — `AgentSkill*` names are intentionally kept
// separate from the A2A `A2XAgentSkill` (AgentCard.skills) type so that
// import paths remain unambiguous.
export type {
  SkillsConfig,
  SkillLogger,
  AgentSkill,
  AgentSkillMetadata,
  AgentSkillBody,
  SkillScriptExecutionMeta,
  DefineSkillInput,
  InlineScriptHandler,
} from './skills/index.js';
export { defineSkill } from './skills/index.js';
export {
  SkillError,
  SkillParseError,
  SkillDiscoveryError,
  SkillConfigError,
  SkillExecutionError,
} from './skills/index.js';

// Layer 3: A2X Integration
export * from './a2x/index.js';

// Layer 4: Transport
export * from './transport/index.js';

// Layer 4: Client
export * from './client/index.js';

// Remote
export * from './remote/index.js';

// x402 (a2a-x402 v0.2 payment support) is NOT re-exported here. It lives
// behind the dedicated `@a2x/sdk/x402` subpath so callers who don't use
// payments don't have to install the `x402` and `viem` peer dependencies
// just to load the main entry. Import from `@a2x/sdk/x402` directly:
//
//   import { X402Context, parseX402PaymentSubmission, ... } from '@a2x/sdk/x402';
