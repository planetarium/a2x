/**
 * Layer 1: AgentCard types for v0.3, v1.0, and internal normalized state.
 */

import type { BaseSecurityScheme } from '../security/base.js';
import type {
  AgentCardSignature,
  AgentExtension,
  AgentProvider,
} from './common.js';
import type {
  SecurityRequirement,
  SecurityRequirementV10,
  SecuritySchemeV03,
  SecuritySchemeV10,
} from './security.js';

// ═══ SDK Internal Normalized State (version-agnostic) ═══

export interface A2XAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: SecurityRequirement[];
}

export interface A2XInterfaceEntry {
  url: string;
  protocol: string; // "JSONRPC" | "GRPC" | "HTTP+JSON" | string
  protocolVersion?: string;
  tenant?: string;
}

export interface A2XAgentState {
  name?: string;
  description?: string;
  version?: string;
  defaultUrl?: string;
  interfaces: A2XInterfaceEntry[];
  provider?: AgentProvider;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extensions?: AgentExtension[];
    extendedAgentCard?: boolean;
    stateTransitionHistory?: boolean;
  };
  securitySchemes: Map<string, BaseSecurityScheme>;
  securityRequirements: SecurityRequirement[];
  skills: A2XAgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  documentationUrl?: string;
  iconUrl?: string;
  supportsAuthenticatedExtendedCard?: boolean;
}

// ═══ v0.3 AgentCard Output Types ═══

export interface AgentCardV03 {
  name: string;
  description: string;
  version: string;
  url: string;
  protocolVersion: string; // "0.3.0"
  preferredTransport?: string;
  additionalInterfaces?: AgentInterfaceV03[];
  provider?: AgentProvider;
  capabilities: AgentCapabilitiesV03;
  securitySchemes?: Record<string, SecuritySchemeV03>;
  security?: SecurityRequirement[];
  skills: AgentSkillV03[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  documentationUrl?: string;
  iconUrl?: string;
  supportsAuthenticatedExtendedCard?: boolean;
  signatures?: AgentCardSignature[];
}

export interface AgentInterfaceV03 {
  url: string;
  transport: string;
}

export interface AgentCapabilitiesV03 {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extensions?: AgentExtension[];
}

export interface AgentSkillV03 {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  security?: SecurityRequirement[];
}

// ═══ v1.0 AgentCard Output Types ═══

export interface AgentCardV10 {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: AgentInterfaceV10[];
  provider?: AgentProvider;
  capabilities: AgentCapabilitiesV10;
  securitySchemes?: Record<string, SecuritySchemeV10>;
  securityRequirements?: SecurityRequirementV10[];
  skills: AgentSkillV10[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  documentationUrl?: string;
  iconUrl?: string;
  signatures?: AgentCardSignature[];
}

export interface AgentInterfaceV10 {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
  tenant?: string;
}

export interface AgentCapabilitiesV10 {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: AgentExtension[];
  extendedAgentCard?: boolean;
}

export interface AgentSkillV10 {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: SecurityRequirementV10[];
}
