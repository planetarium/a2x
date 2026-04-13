/**
 * Layer 3: V10AgentCardMapper - maps internal state to v1.0 AgentCard.
 */

import type {
  A2XAgentState,
  AgentCardV10,
  AgentCapabilitiesV10,
  AgentInterfaceV10,
  AgentSkillV10,
} from '../types/agent-card.js';
import type { SecuritySchemeV10 } from '../types/security.js';
import type { AgentCardMapper } from './agent-card-mapper.js';

export class V10AgentCardMapper implements AgentCardMapper<AgentCardV10> {
  readonly version = '1.0';

  map(state: A2XAgentState): AgentCardV10 {
    const card: AgentCardV10 = {
      name: state.name!,
      description: state.description!,
      version: state.version ?? '1.0.0',
      supportedInterfaces: this.mapInterfaces(state),
      capabilities: this.mapCapabilities(state),
      skills: this.mapSkills(state),
      defaultInputModes: state.defaultInputModes,
      defaultOutputModes: state.defaultOutputModes,
    };

    // provider
    if (state.provider) {
      card.provider = state.provider;
    }

    // securitySchemes
    const schemes = this.mapSecuritySchemes(state);
    if (schemes && Object.keys(schemes).length > 0) {
      card.securitySchemes = schemes;
    }

    // securityRequirements
    if (state.securityRequirements.length > 0) {
      card.securityRequirements = state.securityRequirements;
    }

    // optional fields
    if (state.documentationUrl) {
      card.documentationUrl = state.documentationUrl;
    }
    if (state.iconUrl) {
      card.iconUrl = state.iconUrl;
    }

    return card;
  }

  private mapInterfaces(state: A2XAgentState): AgentInterfaceV10[] {
    const interfaces: AgentInterfaceV10[] = [];

    // Default interface from defaultUrl
    if (state.defaultUrl) {
      interfaces.push({
        url: state.defaultUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      });
    }

    // Additional interfaces
    for (const iface of state.interfaces) {
      interfaces.push({
        url: iface.url,
        protocolBinding: iface.protocol,
        protocolVersion: iface.protocolVersion ?? '1.0',
        ...(iface.tenant ? { tenant: iface.tenant } : {}),
      });
    }

    return interfaces;
  }

  private mapCapabilities(state: A2XAgentState): AgentCapabilitiesV10 {
    const caps: AgentCapabilitiesV10 = {};

    if (state.capabilities.streaming !== undefined) {
      caps.streaming = state.capabilities.streaming;
    }
    if (state.capabilities.pushNotifications !== undefined) {
      caps.pushNotifications = state.capabilities.pushNotifications;
    }
    if (state.capabilities.extensions) {
      caps.extensions = state.capabilities.extensions;
    }
    if (state.capabilities.extendedAgentCard !== undefined) {
      caps.extendedAgentCard = state.capabilities.extendedAgentCard;
    }

    return caps;
  }

  private mapSkills(state: A2XAgentState): AgentSkillV10[] {
    return state.skills.map(
      (skill): AgentSkillV10 => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        ...(skill.examples ? { examples: skill.examples } : {}),
        ...(skill.inputModes ? { inputModes: skill.inputModes } : {}),
        ...(skill.outputModes ? { outputModes: skill.outputModes } : {}),
        // v1.0 uses "securityRequirements"
        ...(skill.securityRequirements
          ? { securityRequirements: skill.securityRequirements }
          : {}),
      }),
    );
  }

  private mapSecuritySchemes(
    state: A2XAgentState,
  ): Record<string, SecuritySchemeV10> | undefined {
    if (state.securitySchemes.size === 0) {
      return undefined;
    }

    const schemes: Record<string, SecuritySchemeV10> = {};

    for (const [name, scheme] of state.securitySchemes) {
      schemes[name] = scheme.toV10Schema();
    }

    return Object.keys(schemes).length > 0 ? schemes : undefined;
  }
}
