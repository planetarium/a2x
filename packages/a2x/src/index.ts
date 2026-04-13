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

// Layer 3: A2X Integration
export * from './a2x/index.js';

// Layer 4: Transport
export * from './transport/index.js';

// Remote (Phase 3 stubs)
export * from './remote/index.js';
