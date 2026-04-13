/**
 * Layer 3: AgentCardMapper interface and factory.
 */

import type { A2XAgentState } from '../types/agent-card.js';

// ─── AgentCardMapper Interface ───

export interface AgentCardMapper<T> {
  readonly version: string;
  map(state: A2XAgentState): T;
}

// ─── AgentCardMapperFactory ───

export class AgentCardMapperFactory {
  static readonly DEFAULT_VERSION = '1.0';
  private static readonly mappers = new Map<string, AgentCardMapper<unknown>>();

  static register(version: string, mapper: AgentCardMapper<unknown>): void {
    AgentCardMapperFactory.mappers.set(version, mapper);
  }

  static getMapper(version?: string): AgentCardMapper<unknown> {
    const v = version ?? AgentCardMapperFactory.DEFAULT_VERSION;
    const mapper = AgentCardMapperFactory.mappers.get(v);
    if (!mapper) {
      throw new Error(
        `AgentCardMapperFactory: no mapper registered for version '${v}'. ` +
          `Supported versions: ${AgentCardMapperFactory.getSupportedVersions().join(', ')}`,
      );
    }
    return mapper;
  }

  static getSupportedVersions(): string[] {
    return Array.from(AgentCardMapperFactory.mappers.keys());
  }
}
