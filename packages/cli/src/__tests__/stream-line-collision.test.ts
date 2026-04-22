/**
 * Tests that streamed artifact text and following status events
 * don't collide on the same line.
 *
 * We spy on process.stdout.write to capture raw output and verify
 * that a newline is inserted between artifact text and status headers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2x/sdk';
import { printStatusUpdate, printArtifactChunk } from '../format.js';

// ---------------------------------------------------------------------------
// Helpers — replicate the midLine logic from stream.ts so we can unit-test it
// in isolation without wiring up Commander and the full stream command.
// ---------------------------------------------------------------------------

type StreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

function createRenderer() {
  let midLine = false;

  function flushLine(): void {
    if (midLine) {
      process.stdout.write('\n');
      midLine = false;
    }
  }

  function renderEvent(event: StreamEvent): void {
    if ('status' in event) {
      flushLine();
      printStatusUpdate(event);
    } else {
      printArtifactChunk(event, true);
      if (event.artifact.parts.some((p) => 'text' in p)) {
        midLine = true;
      }
      if (event.lastChunk) {
        flushLine();
      }
    }
  }

  function finish(): void {
    flushLine();
  }

  return { renderEvent, finish };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function statusEvent(
  taskId: string,
  state: string,
  messageText?: string,
): TaskStatusUpdateEvent {
  return {
    taskId,
    contextId: 'ctx-1',
    status: {
      state: state as TaskStatusUpdateEvent['status']['state'],
      timestamp: new Date().toISOString(),
      ...(messageText
        ? {
            message: {
              messageId: `msg-${Date.now()}`,
              role: 'agent' as const,
              parts: [{ text: messageText }],
            },
          }
        : {}),
    },
    final: state === 'completed',
  } as TaskStatusUpdateEvent;
}

function artifactEvent(
  taskId: string,
  text: string,
  lastChunk = false,
): TaskArtifactUpdateEvent {
  return {
    taskId,
    contextId: 'ctx-1',
    artifact: {
      artifactId: 'art-1',
      parts: [{ text }],
    },
    lastChunk,
  } as TaskArtifactUpdateEvent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stream line collision fix', () => {
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

  it('inserts a newline between artifact text and a following status event', () => {
    const { renderEvent } = createRenderer();

    renderEvent(statusEvent('t-1', 'working', 'Thinking...'));
    renderEvent(artifactEvent('t-1', 'Hello'));
    renderEvent(artifactEvent('t-1', ' world'));
    renderEvent(statusEvent('t-1', 'completed'));

    // The key assertion: after "Hello world" there should be a \n
    // before the status line "[t-1] Status: completed"
    const idx = output.indexOf(' world');
    expect(idx).toBeGreaterThan(-1);
    const afterArtifact = output.slice(idx + ' world'.length);
    expect(afterArtifact.startsWith('\n')).toBe(true);
  });

  it('does not insert spurious newlines between consecutive artifact chunks', () => {
    const { renderEvent } = createRenderer();

    renderEvent(artifactEvent('t-1', 'Hello'));
    renderEvent(artifactEvent('t-1', ' world'));
    renderEvent(artifactEvent('t-1', '!'));

    // No \n should appear between chunks
    expect(output).toContain('Hello world!');
    expect(output).not.toContain('Hello\n');
    expect(output).not.toContain('world\n');
  });

  it('inserts a newline after lastChunk', () => {
    const { renderEvent } = createRenderer();

    renderEvent(artifactEvent('t-1', 'done', true));

    expect(output).toBe('done\n');
  });

  it('finish() flushes a trailing mid-line', () => {
    const { renderEvent, finish } = createRenderer();

    renderEvent(artifactEvent('t-1', 'trailing text'));
    finish();

    expect(output).toBe('trailing text\n');
  });

  it('finish() does not double-newline when line is already flushed', () => {
    const { renderEvent, finish } = createRenderer();

    renderEvent(artifactEvent('t-1', 'text', true)); // lastChunk flushes
    finish();

    // Only one \n after "text"
    expect(output).toBe('text\n');
  });

  it('handles the full interleaved sequence from the issue', () => {
    const { renderEvent, finish } = createRenderer();

    renderEvent(statusEvent('t-abc123', 'working', 'Thinking...'));
    renderEvent(artifactEvent('t-abc123', 'Hello'));
    renderEvent(artifactEvent('t-abc123', ' world'));
    renderEvent(artifactEvent('t-abc123', ', how'));
    renderEvent(artifactEvent('t-abc123', ' are you?', true));
    renderEvent(statusEvent('t-abc123', 'completed'));
    finish();

    // Verify that "are you?" and "[t-abc123] Status: completed" are on separate lines
    const lines = output.split('\n');
    const artifactLine = lines.find((l) => l.includes('are you?'));
    const statusLine = lines.find((l) => l.includes('completed'));
    expect(artifactLine).toBeDefined();
    expect(statusLine).toBeDefined();
    // They should be different lines
    expect(artifactLine).not.toContain('completed');
    expect(statusLine).not.toContain('are you?');
  });
});
