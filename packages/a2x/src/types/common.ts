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

/**
 * Recognize either the SDK-internal flat `FilePart` (`raw` / `url`) or
 * the v0.3 spec wire shape (`{ kind: 'file', file: { bytes | uri, … } }`,
 * `a2a-v0.3.0.json:828-861`). The `Part` type only models the flat
 * form, but a value coming off the wire can be the nested form — and a
 * guard that returned `false` for spec-conformant input would silently
 * mis-classify it (issue #142 fix 5).
 */
export function isFilePart(part: Part): part is FilePart {
  if ('text' in part || 'data' in part) return false;
  if ('raw' in part || 'url' in part) return true;
  // v0.3 spec nested shape: `{ kind: 'file', file: { bytes | uri, … } }`.
  const candidate = part as Record<string, unknown>;
  return (
    candidate.kind === 'file' &&
    typeof candidate.file === 'object' &&
    candidate.file !== null
  );
}

export function isDataPart(part: Part): part is DataPart {
  return 'data' in part;
}

// ─── Role ───

export type Role = 'user' | 'agent';

// ─── v1.0 Role Constants ───

export enum RoleV10 {
  ROLE_USER = 'ROLE_USER',
  ROLE_AGENT = 'ROLE_AGENT',
}

export const ROLE_TO_V10: ReadonlyMap<Role, RoleV10> = new Map([
  ['user', RoleV10.ROLE_USER],
  ['agent', RoleV10.ROLE_AGENT],
]);

export const V10_ROLE_TO_INTERNAL: ReadonlyMap<string, Role> = new Map([
  [RoleV10.ROLE_USER, 'user'],
  [RoleV10.ROLE_AGENT, 'agent'],
]);

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
