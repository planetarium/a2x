/**
 * Layer 1: Common types derived from A2A protocol JSON Schema + proto.
 */

// ─── Part Types ───

export interface PartBase {
  metadata?: Record<string, unknown>;
}

export interface TextPart extends PartBase {
  text: string;
  mediaType?: string;
}

export interface FilePart extends PartBase {
  raw?: string; // base64 encoded
  url?: string;
  filename?: string;
  mediaType?: string;
}

export interface DataPart extends PartBase {
  data: unknown;
  mediaType?: string;
}

export type Part = TextPart | FilePart | DataPart;

// ─── Part Type Guards ───

export function isTextPart(part: Part): part is TextPart {
  return 'text' in part;
}

export function isFilePart(part: Part): part is FilePart {
  return 'raw' in part || ('url' in part && !('text' in part) && !('data' in part));
}

export function isDataPart(part: Part): part is DataPart {
  return 'data' in part;
}

// ─── Role ───

export type Role = 'user' | 'agent';

// ─── Message ───

export interface Message {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: Role;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

// ─── Artifact ───

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

// ─── AgentProvider ───

export interface AgentProvider {
  organization: string;
  url: string;
}

// ─── AgentExtension ───

export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

// ─── AgentCardSignature ───

export interface AgentCardSignature {
  protected: string;
  signature: string;
  header?: Record<string, unknown>;
}
