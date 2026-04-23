/**
 * Regression tests for the two CLI issues that showed up when `a2x a2a
 * stream` met the nextjs-x402 sample's embedded flow:
 *
 *  1. `printArtifactChunk` dumped `JSON.stringify(part.data)` for the
 *     embedded challenge artifact straight into the streaming-text
 *     column, collapsing the pretty challenge display onto the same
 *     line as the agent's narration.
 *  2. The stream command's renderer didn't recognise embedded challenge
 *     artifacts, so it kept rendering them even though the payment
 *     dance was about to re-print them anyway.
 *
 * These tests lock in the fix: the renderer we now use in
 * `commands/a2a/stream.ts` detects challenge artifacts via
 * `isEmbeddedChallengeArtifact`, flushes any in-flight text line, and
 * emits nothing else — leaving the payment-block rendering to the
 * payment dance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Artifact, TaskArtifactUpdateEvent } from '@a2x/sdk';
import { printArtifactChunk, printStatusUpdate } from '../format.js';
import { isEmbeddedChallengeArtifact } from '../x402-cli.js';

// Mirror the renderer used by `commands/a2a/stream.ts` so we can test
// it without wiring Commander + network up.
function createRenderer() {
  let midLine = false;
  const flushLine = (): void => {
    if (midLine) {
      process.stdout.write('\n');
      midLine = false;
    }
  };
  function renderEvent(event: TaskArtifactUpdateEvent): void {
    if (isEmbeddedChallengeArtifact(event.artifact)) {
      flushLine();
      return;
    }
    printArtifactChunk(event, true);
    if (event.artifact.parts.some((p) => 'text' in p)) midLine = true;
    if (event.lastChunk) flushLine();
  }
  return { renderEvent, flushLine };
}

function textArtifactEvent(text: string, lastChunk = false): TaskArtifactUpdateEvent {
  return {
    taskId: 't',
    contextId: 'c',
    artifact: { artifactId: 'art-text', parts: [{ text }] },
    lastChunk,
  } as TaskArtifactUpdateEvent;
}

function challengeArtifact(): Artifact {
  return {
    artifactId: 'challenge-1',
    name: 'demo-cart',
    parts: [
      {
        data: {
          cartId: 'cart-xyz',
          total: { currency: 'USD', value: 120 },
          'x402.payment.required': {
            x402Version: 1,
            accepts: [
              {
                scheme: 'exact',
                network: 'base-sepolia',
                maxAmountRequired: '120000000',
                resource: 'a2a-x402/access',
                description: 'Checkout',
                mimeType: 'application/json',
                payTo: '0x1111111111111111111111111111111111111111',
                maxTimeoutSeconds: 300,
                asset: '0x2222222222222222222222222222222222222222',
                extra: { name: 'USDC', version: '2' },
              },
            ],
          },
        },
      },
    ],
  };
}

function challengeArtifactEvent(): TaskArtifactUpdateEvent {
  return {
    taskId: 't',
    contextId: 'c',
    artifact: challengeArtifact(),
    lastChunk: true,
  } as TaskArtifactUpdateEvent;
}

function ap2WrappedChallengeArtifact(): Artifact {
  // A higher-level wrapper (AP2-style) where the x402 payload is
  // nested inside a method_data entry. `getEmbeddedX402Challenges` is
  // expected to find it recursively.
  return {
    artifactId: 'challenge-2',
    name: 'AP2 CartMandate',
    parts: [
      {
        data: {
          'ap2.mandates.CartMandate': {
            id: 'cart-shoes',
            payment_request: {
              method_data: [
                {
                  supported_methods: 'https://www.x402.org/',
                  data: {
                    x402Version: 1,
                    accepts: [
                      {
                        scheme: 'exact',
                        network: 'base',
                        maxAmountRequired: '120000000',
                        resource: 'a2a-x402/access',
                        description: 'Checkout',
                        mimeType: 'application/json',
                        payTo: '0xAAA',
                        maxTimeoutSeconds: 300,
                        asset: '0xBBB',
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    ],
  };
}

describe('isEmbeddedChallengeArtifact', () => {
  it('recognises the bare shape the SDK emits', () => {
    expect(isEmbeddedChallengeArtifact(challengeArtifact())).toBe(true);
  });

  it('recognises an x402 payload nested inside an AP2-style wrapper', () => {
    expect(isEmbeddedChallengeArtifact(ap2WrappedChallengeArtifact())).toBe(true);
  });

  it('does not flag a plain text artifact', () => {
    const art: Artifact = {
      artifactId: 'art',
      parts: [{ text: 'hello' }],
    };
    expect(isEmbeddedChallengeArtifact(art)).toBe(false);
  });

  it('does not flag a data artifact without an x402 challenge', () => {
    const art: Artifact = {
      artifactId: 'art',
      parts: [{ data: { cartId: 'c1', total: 100 } }],
    };
    expect(isEmbeddedChallengeArtifact(art)).toBe(false);
  });
});

describe('stream renderer + embedded challenge', () => {
  let output: string;
  const originalWrite = process.stdout.write;

  beforeEach(() => {
    output = '';
    process.stdout.write = ((chunk: unknown) => {
      output += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('does not dump the challenge JSON into the text stream', () => {
    const { renderEvent } = createRenderer();

    renderEvent(textArtifactEvent('Adding Nike Air Max to cart… '));
    renderEvent(challengeArtifactEvent());

    // The JSON keys of the challenge MUST NOT leak into the rendered
    // output; the payment dance re-renders the challenge after.
    expect(output).toContain('Adding Nike Air Max to cart… ');
    expect(output).not.toContain('x402.payment.required');
    expect(output).not.toContain('cart-xyz');
    expect(output).not.toContain('maxAmountRequired');
  });

  it('flushes any in-flight text line before the payment dance runs', () => {
    const { renderEvent } = createRenderer();

    renderEvent(textArtifactEvent('Adding Nike Air Max to cart… '));
    renderEvent(challengeArtifactEvent());

    // After the challenge artifact is seen, a trailing newline must
    // separate the stream text from whatever comes next (the payment
    // block). Otherwise the same line collision from the ticket
    // returns.
    expect(output.endsWith('\n')).toBe(true);
  });

  it('still renders a non-challenge text artifact normally', () => {
    const { renderEvent } = createRenderer();

    renderEvent(textArtifactEvent('Hello ', false));
    renderEvent(textArtifactEvent('world', true));

    expect(output).toContain('Hello world');
  });
});

// Ensure the imported `printStatusUpdate` still compiles into the
// test's symbol table — otherwise ESLint complains the import is
// unused. This is a belt-and-braces no-op.
void printStatusUpdate;
