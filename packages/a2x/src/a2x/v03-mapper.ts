/**
 * Layer 3: V03AgentCardMapper - maps internal state to v0.3 AgentCard.
 */

import type {
  A2XAgentState,
  AgentCardV03,
  AgentCapabilitiesV03,
  AgentInterfaceV03,
  AgentSkillV03,
} from '../types/agent-card.js';
import type { SecuritySchemeV03 } from '../types/security.js';
import type { AgentCardMapper } from './agent-card-mapper.js';

export class V03AgentCardMapper implements AgentCardMapper<AgentCardV03> {
  readonly version = '0.3';

  map(state: A2XAgentState): AgentCardV03 {
    const card: AgentCardV03 = {
      name: state.name!,
      description: state.description!,
      version: state.version ?? '1.0.0',
      url: state.defaultUrl ?? '',
      protocolVersion: '0.3.0',
      provider: state.provider,
      capabilities: this.mapCapabilities(state),
      skills: this.mapSkills(state),
      defaultInputModes: state.defaultInputModes,
      defaultOutputModes: state.defaultOutputModes,
    };

    // preferredTransport
    card.preferredTransport = 'JSONRPC';

    // additionalInterfaces
    if (state.interfaces.length > 0) {
      card.additionalInterfaces = state.interfaces.map(
        (iface): AgentInterfaceV03 => ({
          url: iface.url,
          transport: iface.protocol,
        }),
      );
    }

    // securitySchemes
    const schemes = this.mapSecuritySchemes(state);
    if (schemes && Object.keys(schemes).length > 0) {
      card.securitySchemes = schemes;
    }

    // security (requirements)
    if (state.securityRequirements.length > 0) {
      card.security = state.securityRequirements;
    }

    // optional fields
    if (state.documentationUrl) {
      card.documentationUrl = state.documentationUrl;
    }
    if (state.iconUrl) {
      card.iconUrl = state.iconUrl;
    }
    if (state.supportsAuthenticatedExtendedCard !== undefined) {
      card.supportsAuthenticatedExtendedCard =
        state.supportsAuthenticatedExtendedCard;
    }

    return card;
  }

  private mapCapabilities(state: A2XAgentState): AgentCapabilitiesV03 {
    const caps: AgentCapabilitiesV03 = {};

    if (state.capabilities.streaming !== undefined) {
      caps.streaming = state.capabilities.streaming;
    }
    if (state.capabilities.pushNotifications !== undefined) {
      caps.pushNotifications = state.capabilities.pushNotifications;
    }
    if (state.capabilities.stateTransitionHistory !== undefined) {
      caps.stateTransitionHistory = state.capabilities.stateTransitionHistory;
    }
    if (state.capabilities.extensions) {
      caps.extensions = state.capabilities.extensions;
    }

    return caps;
  }

  private mapSkills(state: A2XAgentState): AgentSkillV03[] {
    return state.skills.map(
      (skill): AgentSkillV03 => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        ...(skill.examples ? { examples: skill.examples } : {}),
        ...(skill.inputModes ? { inputModes: skill.inputModes } : {}),
        ...(skill.outputModes ? { outputModes: skill.outputModes } : {}),
        // v0.3 uses "security" instead of "securityRequirements"
        ...(skill.securityRequirements
          ? { security: skill.securityRequirements }
          : {}),
      }),
    );
  }

  private mapSecuritySchemes(
    state: A2XAgentState,
  ): Record<string, SecuritySchemeV03> | undefined {
    if (state.securitySchemes.size === 0) {
      return undefined;
    }

    const schemes: Record<string, SecuritySchemeV03> = {};

    for (const [name, scheme] of state.securitySchemes) {
      const v03Schema = scheme.toV03Schema();
      if (v03Schema !== null) {
        schemes[name] = v03Schema;
      }
      // If null, the scheme has no v0.3 representation; the scheme's
      // toV03Schema() is expected to have emitted a warning.
    }

    return Object.keys(schemes).length > 0 ? schemes : undefined;
  }
}
