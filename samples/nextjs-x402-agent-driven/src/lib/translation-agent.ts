/**
 * Anthropic-powered demo agent that owns the payment decision.
 *
 * Generalized over a tool registry — each tool declares its own cost (0 for
 * free tools, an atomic-unit cost for paid ones). The agent inspects EVERY
 * tool call returned by the LLM (Anthropic supports parallel tool use, so a
 * single planning response can include several), validates them, then:
 *
 *   - all tool calls free → execute the batch directly.
 *   - at least one paid call AND not yet settled → sum the costs, advertise
 *     a single combined `accept`, yield `x402RequestPayment`, return.
 *   - already settled → execute the entire batch (paid + free in declared
 *     order) and feed the results back to Claude for a final summary.
 *
 * Adding a new tool means adding one entry to TOOLS — no other code changes.
 */

import {
  BaseAgent,
  isTextPart,
  readX402Settlement,
  x402RequestPayment,
} from '@a2x/sdk';
import type {
  AgentEvent,
  InvocationContext,
  Message,
  Part,
  TextPart,
  ToolCall,
  ToolDeclaration,
  X402Accept,
} from '@a2x/sdk';
import type { AnthropicProvider } from '@a2x/sdk/anthropic';

// ─── Tool registry ──────────────────────────────────────────

interface ToolDeps {
  provider: AnthropicProvider;
}

interface ToolHandler {
  declaration: ToolDeclaration;
  /** Cost in atomic USDC units (6 decimals). 0 = free. */
  costAtomic: number;
  /**
   * Validate raw LLM-supplied args. Throw on schema mismatch — the agent
   * surfaces the error before any payment or execution side-effect.
   */
  validate(args: unknown): void;
  execute(args: Record<string, unknown>, deps: ToolDeps): Promise<unknown>;
}

const TRANSLATE: ToolHandler = {
  declaration: {
    name: 'translate',
    description:
      'Translate a piece of text into the requested target language. Use ' +
      'this whenever the user asks for a translation. Do not attempt to ' +
      'translate yourself without calling this tool.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The source text to translate.' },
        target_language: {
          type: 'string',
          description:
            'The target language as a common name (e.g. "korean", ' +
            '"spanish", "japanese"). Lowercase preferred.',
        },
      },
      required: ['text', 'target_language'],
    },
  },
  costAtomic: 10_000, // 0.01 USDC
  validate(args) {
    const a = args as Record<string, unknown>;
    if (typeof a.text !== 'string' || a.text.length === 0) {
      throw new Error('translate.text must be a non-empty string');
    }
    if (
      typeof a.target_language !== 'string' ||
      a.target_language.length === 0
    ) {
      throw new Error('translate.target_language must be a non-empty string');
    }
  },
  async execute(args, { provider }) {
    const { text, target_language } = args as {
      text: string;
      target_language: string;
    };
    const resp = await provider.generateContent({
      contents: [
        {
          messageId: `t-${Date.now()}`,
          role: 'user',
          parts: [
            {
              text:
                `Translate the following text into ${target_language}. ` +
                'Output ONLY the translation — no preamble, no commentary, ' +
                `no surrounding quotes.\n\n${text}`,
            },
          ],
        },
      ],
      systemInstruction:
        'You are a professional translator. Output only the translated ' +
        'text, nothing else.',
    });
    return joinText(resp.content);
  },
};

const SUMMARIZE: ToolHandler = {
  declaration: {
    name: 'summarize',
    description:
      'Produce a one-sentence summary of a passage of text. Use this when ' +
      'the user asks for a summary, a TL;DR, or a condensed version.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to summarize.' },
      },
      required: ['text'],
    },
  },
  costAtomic: 5_000, // 0.005 USDC
  validate(args) {
    const a = args as Record<string, unknown>;
    if (typeof a.text !== 'string' || a.text.length === 0) {
      throw new Error('summarize.text must be a non-empty string');
    }
  },
  async execute(args, { provider }) {
    const { text } = args as { text: string };
    const resp = await provider.generateContent({
      contents: [
        {
          messageId: `s-${Date.now()}`,
          role: 'user',
          parts: [
            {
              text:
                'Summarize the following text in ONE sentence. Output only ' +
                `the summary — no preamble.\n\n${text}`,
            },
          ],
        },
      ],
      systemInstruction:
        'You are a concise summarizer. Output a single sentence and nothing else.',
    });
    return joinText(resp.content);
  },
};

const DETECT_LANGUAGE: ToolHandler = {
  declaration: {
    name: 'detect_language',
    description:
      'Detect the natural language of a piece of text. Returns a single ' +
      'language name (e.g. "english", "korean", "japanese").',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text whose language to detect.' },
      },
      required: ['text'],
    },
  },
  costAtomic: 0,
  validate(args) {
    const a = args as Record<string, unknown>;
    if (typeof a.text !== 'string' || a.text.length === 0) {
      throw new Error('detect_language.text must be a non-empty string');
    }
  },
  async execute(args, { provider }) {
    const { text } = args as { text: string };
    const resp = await provider.generateContent({
      contents: [
        {
          messageId: `d-${Date.now()}`,
          role: 'user',
          parts: [
            {
              text:
                'What language is the following text written in? Reply with ' +
                'ONLY the language name in lowercase (e.g. "english", ' +
                `"korean") — no commentary.\n\n${text}`,
            },
          ],
        },
      ],
      systemInstruction:
        'You are a language detector. Output only the language name.',
    });
    return joinText(resp.content).toLowerCase();
  },
};

const WORD_COUNT: ToolHandler = {
  declaration: {
    name: 'word_count',
    description:
      'Count the number of whitespace-separated words in a piece of text. ' +
      'Deterministic, no LLM call.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to count words in.' },
      },
      required: ['text'],
    },
  },
  costAtomic: 0,
  validate(args) {
    const a = args as Record<string, unknown>;
    if (typeof a.text !== 'string') {
      throw new Error('word_count.text must be a string');
    }
  },
  async execute(args) {
    const { text } = args as { text: string };
    const trimmed = text.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  },
};

const TOOLS: Record<string, ToolHandler> = {
  translate: TRANSLATE,
  summarize: SUMMARIZE,
  detect_language: DETECT_LANGUAGE,
  word_count: WORD_COUNT,
};

// ─── Agent ──────────────────────────────────────────────────

export interface TranslationAgentOptions {
  provider: AnthropicProvider;
  /**
   * Network details for the per-turn bill. The agent assembles a single
   * `accept` whose `amount` is the sum of the per-tool atomic costs of every
   * paid tool call the LLM emitted on the planning turn.
   */
  payment: {
    network: 'base-sepolia' | 'base';
    asset: string;
    payTo: string;
    resource: string;
  };
}

const SYSTEM_PROMPT =
  'You are a helpful assistant with these tools: translate (paid), ' +
  'summarize (paid), detect_language (free), word_count (free). When the ' +
  'user asks for something that maps cleanly to one or more tools, call ' +
  'them. You may call multiple tools in a single response when the request ' +
  'naturally needs more than one. For free chat or anything outside these ' +
  'tools, answer directly without calling any tool.';

export class TranslationAgent extends BaseAgent {
  private readonly _provider: AnthropicProvider;
  private readonly _payment: TranslationAgentOptions['payment'];
  private readonly _toolDeclarations: ToolDeclaration[];

  constructor(options: TranslationAgentOptions) {
    super({
      name: 'translation_agent',
      description:
        'Anthropic-powered chat agent with multiple tools. Charges per-turn ' +
        'whenever the LLM picks one or more paid tools, summing each tool ' +
        "'s cost into a single x402 payment.",
    });
    this._provider = options.provider;
    this._payment = options.payment;
    this._toolDeclarations = Object.values(TOOLS).map((t) => t.declaration);
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const settled = readX402Settlement(context).paid;
    const userText = lastUserText(context);

    // Phase 1 — Claude plans against the full tool registry.
    const planResp = await this._provider.generateContent({
      contents: [
        { messageId: 'u1', role: 'user', parts: [{ text: userText }] },
      ],
      systemInstruction: SYSTEM_PROMPT,
      tools: this._toolDeclarations,
    });

    const toolCalls = planResp.toolCalls ?? [];

    if (toolCalls.length === 0) {
      // No tools needed. Pass Claude's reply through.
      for (const part of planResp.content) {
        if (isTextPart(part) && part.text) {
          yield { type: 'text', role: 'agent', text: part.text };
        }
      }
      yield { type: 'done' };
      return;
    }

    // Validate every call before any side-effect (charging or executing).
    // An unknown tool name or schema-broken args is the LLM's fault; we
    // surface it as an agent error rather than silently dropping or charging.
    for (const tc of toolCalls) {
      const handler = TOOLS[tc.name];
      if (!handler) {
        yield {
          type: 'error',
          error: new Error(`Unknown tool: ${tc.name}`),
        };
        return;
      }
      try {
        handler.validate(tc.args);
      } catch (err) {
        yield {
          type: 'error',
          error: new Error(
            `Invalid args for ${tc.name}: ${(err as Error).message}`,
          ),
        };
        return;
      }
    }

    // Sum the per-tool cost across the batch. Free tools contribute 0.
    const totalAtomic = toolCalls.reduce(
      (sum, tc) => sum + (TOOLS[tc.name]?.costAtomic ?? 0),
      0,
    );

    if (totalAtomic > 0 && !settled) {
      // At least one paid call in the batch. Gate before any execution —
      // including the free calls in the batch, so the user sees a single
      // consistent "you're paying for this turn" prompt.
      yield* x402RequestPayment({
        accepts: [this._buildAccept(totalAtomic)],
        description: this._billDescription(toolCalls, totalAtomic),
      });
      return;
    }

    // Either fully free, or already paid. Execute every tool call in
    // declared order and feed the results to Claude for the final reply.
    const toolResults: Array<{ id: string; name: string; result: unknown }> = [];
    for (const tc of toolCalls) {
      yield {
        type: 'toolCall',
        toolName: tc.name,
        args: tc.args,
        toolCallId: tc.id,
      };
      const handler = TOOLS[tc.name];
      let result: unknown;
      try {
        result = await handler.execute(tc.args, { provider: this._provider });
      } catch (err) {
        result = `Error: ${tc.name} execution failed: ${(err as Error).message}`;
      }
      yield {
        type: 'toolResult',
        toolName: tc.name,
        result,
        toolCallId: tc.id,
      };
      toolResults.push({ id: tc.id, name: tc.name, result });
    }

    // Phase 2 — Claude composes the final answer with all tool results in
    // hand. Anthropic's API requires the assistant's tool_use blocks and
    // the user's tool_result blocks to sit in adjacent messages with
    // matching ids; we assemble that conversation by hand.
    const planTextParts: Part[] = planResp.content
      .filter((p): p is TextPart => isTextPart(p))
      .map((p) => ({ text: p.text }));
    const followupContents: Message[] = [
      { messageId: 'u1', role: 'user', parts: [{ text: userText }] },
      {
        messageId: 'a1',
        role: 'agent',
        parts: planTextParts.length > 0 ? planTextParts : [{ text: '' }],
        metadata: { toolCalls },
      },
      {
        messageId: 't1',
        role: 'user',
        parts: [{ text: '' }],
        metadata: { toolResults },
      },
    ];

    const finalResp = await this._provider.generateContent({
      contents: followupContents,
      systemInstruction: SYSTEM_PROMPT,
    });

    for (const part of finalResp.content) {
      if (isTextPart(part) && part.text) {
        yield { type: 'text', role: 'agent', text: part.text };
      }
    }
    yield { type: 'done' };
  }

  private _buildAccept(totalAtomic: number): X402Accept {
    return {
      network: this._payment.network,
      // x402 amount is an atomic-unit decimal string (USDC has 6 decimals).
      amount: String(totalAtomic),
      asset: this._payment.asset,
      payTo: this._payment.payTo,
      resource: this._payment.resource,
      description: 'Per-turn paid tool execution',
    };
  }

  private _billDescription(
    toolCalls: ToolCall[],
    totalAtomic: number,
  ): string {
    const lines = toolCalls.map((tc) => {
      const cost = TOOLS[tc.name]?.costAtomic ?? 0;
      const note = cost > 0 ? `${formatUsdc(cost)} USDC` : 'free';
      return `- ${tc.name}: ${note}`;
    });
    lines.unshift('About to run:');
    lines.push(`Total: ${formatUsdc(totalAtomic)} USDC`);
    return lines.join('\n');
  }
}

// ─── Helpers ────────────────────────────────────────────────

function lastUserText(context: InvocationContext): string {
  for (let i = context.session.events.length - 1; i >= 0; i--) {
    const event = context.session.events[i];
    if (event.type === 'text' && event.role === 'user') return event.text;
  }
  return '';
}

function joinText(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => isTextPart(p))
    .map((p) => p.text)
    .join('')
    .trim();
}

function formatUsdc(atomic: number): string {
  const whole = Math.floor(atomic / 1_000_000);
  const frac = atomic % 1_000_000;
  return `${whole}.${frac.toString().padStart(6, '0')}`;
}
