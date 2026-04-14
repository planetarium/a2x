/**
 * Layer 2: Callback Runner.
 * Executes plugin and agent callbacks in the correct order.
 *
 * Execution order:
 * 1. Plugin callbacks in registration order (sequential)
 * 2. Agent callback last
 * If any callback returns non-undefined, subsequent callbacks are skipped.
 */

import type { BaseTool } from '../tool/base-tool.js';
import type { BasePlugin } from '../plugin/base-plugin.js';
import type { InvocationContext } from './context.js';
import type { ModelRequest, ModelResponse } from '../agent/llm-provider.js';
import type { BeforeModelCallback, AfterModelCallback, BeforeToolCallback } from '../agent/llm-agent.js';

// ─── beforeModel ───

export async function runBeforeModelCallbacks(
  request: ModelRequest,
  context: InvocationContext,
  plugins: BasePlugin[],
  agentCallback?: BeforeModelCallback,
): Promise<ModelResponse | undefined> {
  for (const plugin of plugins) {
    if (plugin.beforeModelCallback) {
      const result = await plugin.beforeModelCallback(request, context);
      if (result !== undefined) return result;
    }
  }
  if (agentCallback) {
    return agentCallback(request, context);
  }
  return undefined;
}

// ─── afterModel ───

export async function runAfterModelCallbacks(
  response: ModelResponse,
  context: InvocationContext,
  plugins: BasePlugin[],
  agentCallback?: AfterModelCallback,
): Promise<ModelResponse> {
  let current = response;
  for (const plugin of plugins) {
    if (plugin.afterModelCallback) {
      const result = await plugin.afterModelCallback(current, context);
      if (result !== undefined) current = result;
    }
  }
  if (agentCallback) {
    const result = await agentCallback(current, context);
    if (result !== undefined) current = result;
  }
  return current;
}

// ─── beforeTool ───

export async function runBeforeToolCallbacks(
  tool: BaseTool,
  args: Record<string, unknown>,
  context: InvocationContext,
  plugins: BasePlugin[],
  agentCallback?: BeforeToolCallback,
): Promise<unknown | undefined> {
  for (const plugin of plugins) {
    if (plugin.beforeToolCallback) {
      const result = await plugin.beforeToolCallback(tool, args, context);
      if (result !== undefined) return result;
    }
  }
  if (agentCallback) {
    return agentCallback(tool, args, context);
  }
  return undefined;
}

// ─── afterTool ───

export async function runAfterToolCallbacks(
  tool: BaseTool,
  args: Record<string, unknown>,
  result: unknown,
  context: InvocationContext,
  plugins: BasePlugin[],
): Promise<unknown> {
  let current = result;
  for (const plugin of plugins) {
    if (plugin.afterToolCallback) {
      const modified = await plugin.afterToolCallback(tool, args, current, context);
      if (modified !== undefined) current = modified;
    }
  }
  return current;
}
