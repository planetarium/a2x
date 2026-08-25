import { describe, it, expect } from 'vitest';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { TaskState } from '../types/task.js';
import type {
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '../types/task.js';
import { isFilePart, isDataPart, isTextPart } from '../types/common.js';

// ─── Test agents that yield non-text AgentEvents ───

class FileEmittingAgent extends BaseAgent {
  constructor() {
    super({ name: 'file-agent' });
  }

  async *run(_ctx: InvocationContext): AsyncGenerator<AgentEvent> {
    yield {
      type: 'file',
      file: {
        url: 'https://example.com/cat.png',
        mediaType: 'image/png',
        filename: 'cat.png',
      },
    };
    yield { type: 'done' };
  }
}

class DataEmittingAgent extends BaseAgent {
  constructor() {
    super({ name: 'data-agent' });
  }

  async *run(_ctx: InvocationContext): AsyncGenerator<AgentEvent> {
    yield {
      type: 'data',
      data: { score: 0.92, label: 'cat' },
      mediaType: 'application/json',
    };
    yield { type: 'done' };
  }
}

class MixedAgent extends BaseAgent {
  constructor() {
    super({ name: 'mixed-agent' });
  }

  async *run(_ctx: InvocationContext): AsyncGenerator<AgentEvent> {
    yield { type: 'text', text: 'Here is your image:', role: 'agent' };
    yield {
      type: 'file',
      file: { raw: 'base64-bytes-here', mediaType: 'image/png' },
    };
    yield { type: 'text', text: ' and structured data:', role: 'agent' };
    yield { type: 'data', data: { ok: true } };
    yield { type: 'done' };
  }
}

class DescribedMixedAgent extends BaseAgent {
  constructor() {
    super({ name: 'described-mixed-agent' });
  }

  async *run(): AsyncGenerator<AgentEvent> {
    yield {
      type: 'text',
      text: 'hello ',
      artifact: {
        name: 'result.txt',
        metadata: { format: 'plain', schema: { version: 1 } },
        extensions: ['https://example.com/extensions/base'],
      },
      deliveryMetadata: { delivery: 'first' },
    };
    yield {
      type: 'text',
      text: 'world',
      artifact: {
        description: 'Consolidated result',
        metadata: { confidence: 0.9, schema: { version: 1 } },
        extensions: [
          'https://example.com/extensions/base',
          'https://example.com/extensions/confidence',
        ],
      },
      deliveryMetadata: { delivery: 'second' },
    };
    yield {
      type: 'file',
      file: { url: 'https://example.com/result.json' },
      artifact: {
        name: 'result.json',
        metadata: { format: 'json' },
      },
      deliveryMetadata: { delivery: 'file' },
    };
    yield {
      type: 'data',
      data: { ok: true },
      artifact: {
        name: 'summary',
        metadata: { format: 'summary' },
      },
      deliveryMetadata: { delivery: 'data' },
    };
    yield { type: 'done' };
  }
}

function makeTask(id = 'task-1'): Task {
  return {
    id,
    contextId: `ctx-${id}`,
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  };
}

function makeExecutor(agent: BaseAgent): AgentExecutor {
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  return new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
}

const message = {
  messageId: 'm-1',
  role: 'user' as const,
  parts: [{ text: 'go' }],
};

// ─── execute() (non-streaming) path ───

describe('AgentExecutor.execute — content AgentEvents', () => {
  it('maps a file event to a FilePart artifact', async () => {
    const task = await makeExecutor(new FileEmittingAgent()).execute(
      makeTask(),
      message,
    );

    expect(task.status.state).toBe(TaskState.COMPLETED);
    expect(task.artifacts).toBeDefined();
    expect(task.artifacts).toHaveLength(1);

    const [part] = task.artifacts![0].parts;
    expect(isFilePart(part)).toBe(true);
    if (isFilePart(part)) {
      expect(part.url).toBe('https://example.com/cat.png');
      expect(part.mediaType).toBe('image/png');
      expect(part.filename).toBe('cat.png');
    }
  });

  it('maps a data event to a DataPart artifact', async () => {
    const task = await makeExecutor(new DataEmittingAgent()).execute(
      makeTask(),
      message,
    );

    expect(task.artifacts).toHaveLength(1);
    const [part] = task.artifacts![0].parts;
    expect(isDataPart(part)).toBe(true);
    if (isDataPart(part)) {
      expect(part.data).toEqual({ score: 0.92, label: 'cat' });
      expect(part.mediaType).toBe('application/json');
    }
  });

  it('produces a separate artifact per non-text event and keeps text accumulated', async () => {
    const task = await makeExecutor(new MixedAgent()).execute(
      makeTask(),
      message,
    );

    // 1 file + 1 data + 1 accumulated-text = 3 artifacts, each a single part.
    expect(task.artifacts).toHaveLength(3);
    expect(task.artifacts!.every((a) => a.parts.length === 1)).toBe(true);

    const partKinds = task.artifacts!.map((a) =>
      isTextPart(a.parts[0])
        ? 'text'
        : isFilePart(a.parts[0])
          ? 'file'
          : isDataPart(a.parts[0])
            ? 'data'
            : 'unknown',
    );
    expect(partKinds.sort()).toEqual(['data', 'file', 'text']);

    // Text artifact concatenates both text events.
    const textArtifact = task.artifacts!.find(
      (a) => isTextPart(a.parts[0]),
    )!;
    const textPart = textArtifact.parts[0];
    if (isTextPart(textPart)) {
      expect(textPart.text).toBe('Here is your image: and structured data:');
    }
  });

  it('preserves artifact descriptors for text, file, and data events', async () => {
    const task = await makeExecutor(new DescribedMixedAgent()).execute(
      makeTask(),
      message,
    );

    const textArtifact = task.artifacts!.find((artifact) =>
      isTextPart(artifact.parts[0]),
    )!;
    expect(textArtifact).toMatchObject({
      name: 'result.txt',
      description: 'Consolidated result',
      metadata: {
        format: 'plain',
        confidence: 0.9,
        schema: { version: 1 },
      },
      extensions: [
        'https://example.com/extensions/base',
        'https://example.com/extensions/confidence',
      ],
    });
    expect(textArtifact.parts).toEqual([{ text: 'hello world' }]);

    const fileArtifact = task.artifacts!.find((artifact) =>
      isFilePart(artifact.parts[0]),
    )!;
    expect(fileArtifact).toMatchObject({
      name: 'result.json',
      metadata: { format: 'json' },
    });

    const dataArtifact = task.artifacts!.find((artifact) =>
      isDataPart(artifact.parts[0]),
    )!;
    expect(dataArtifact).toMatchObject({
      name: 'summary',
      metadata: { format: 'summary' },
    });
  });

  it('fails the task when text chunks provide conflicting artifact metadata', async () => {
    class ConflictingMetadataAgent extends BaseAgent {
      async *run(): AsyncGenerator<AgentEvent> {
        const schema = { version: 1 };
        yield {
          type: 'text',
          text: 'kept',
          artifact: { metadata: { schema } },
        };
        schema.version = 2;
        yield {
          type: 'text',
          text: 'discarded',
          artifact: { metadata: { schema: { version: 2 } } },
        };
      }
    }

    const task = await makeExecutor(
      new ConflictingMetadataAgent({ name: 'conflict' }),
    ).execute(makeTask(), message);

    expect(task.status.state).toBe(TaskState.FAILED);
    expect(task.status.message?.parts).toEqual([
      { text: 'Conflicting text artifact metadata key: schema' },
    ]);
    expect(task.artifacts).toMatchObject([
      {
        metadata: { schema: { version: 1 } },
        parts: [{ text: 'kept' }],
      },
    ]);
  });

  it('preserves metadata keys that overlap Object prototype accessors', async () => {
    class PrototypeKeyAgent extends BaseAgent {
      async *run(): AsyncGenerator<AgentEvent> {
        yield {
          type: 'text',
          text: 'first',
          artifact: { metadata: { first: true } },
        };
        yield {
          type: 'text',
          text: 'second',
          artifact: {
            metadata: JSON.parse('{"__proto__":{"polluted":true}}') as Record<
              string,
              unknown
            >,
          },
        };
      }
    }

    const task = await makeExecutor(
      new PrototypeKeyAgent({ name: 'prototype-key' }),
    ).execute(makeTask(), message);
    const metadata = task.artifacts![0].metadata!;

    expect(task.status.state).toBe(TaskState.COMPLETED);
    expect(Object.keys(metadata)).toEqual(['first', '__proto__']);
    expect(metadata['__proto__']).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

// ─── executeStream() (SSE) path ───

describe('AgentExecutor.executeStream — content AgentEvents', () => {
  async function collect(
    stream: AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>,
  ): Promise<(TaskStatusUpdateEvent | TaskArtifactUpdateEvent)[]> {
    const events: (TaskStatusUpdateEvent | TaskArtifactUpdateEvent)[] = [];
    for await (const e of stream) events.push(e);
    return events;
  }

  function isArtifactEvent(
    e: TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
  ): e is TaskArtifactUpdateEvent {
    return 'artifact' in e;
  }

  it('emits a FilePart artifact update inline (lastChunk=true, append=false)', async () => {
    const task = makeTask();
    const events = await collect(
      makeExecutor(new FileEmittingAgent()).executeStream(task, message),
    );

    const artifactEvents = events.filter(isArtifactEvent);
    expect(artifactEvents).toHaveLength(1);
    const fileEvent = artifactEvents[0];
    expect(fileEvent.append).toBe(false);
    expect(fileEvent.lastChunk).toBe(true);

    const [part] = fileEvent.artifact.parts;
    expect(isFilePart(part)).toBe(true);

    // Final task object should reflect the artifact too.
    expect(task.artifacts).toHaveLength(1);
  });

  it('emits a DataPart artifact update inline', async () => {
    const task = makeTask();
    const events = await collect(
      makeExecutor(new DataEmittingAgent()).executeStream(task, message),
    );

    const artifactEvents = events.filter(isArtifactEvent);
    expect(artifactEvents).toHaveLength(1);
    const part = artifactEvents[0].artifact.parts[0];
    expect(isDataPart(part)).toBe(true);
    if (isDataPart(part)) {
      expect(part.data).toEqual({ score: 0.92, label: 'cat' });
    }
  });

  it('streams text incrementally and file/data as their own artifacts', async () => {
    const task = makeTask();
    const events = await collect(
      makeExecutor(new MixedAgent()).executeStream(task, message),
    );

    const artifactEvents = events.filter(isArtifactEvent);

    // 2 text chunks + 1 file + 1 data + 1 consolidated final text.
    expect(artifactEvents).toHaveLength(5);

    const textUpdates = artifactEvents.filter((e) =>
      isTextPart(e.artifact.parts[0]),
    );
    // The first text chunk establishes the artifact; later chunks append,
    // and `done` replaces it with the consolidated final value.
    expect(textUpdates.map((e) => e.append)).toEqual([false, true, false]);

    const finalUpdates = artifactEvents.filter((e) => e.append === false);
    expect(finalUpdates).toHaveLength(4);

    // Final artifact set on task: 1 file + 1 data + 1 text = 3 artifacts.
    expect(task.artifacts).toHaveLength(3);
  });

  it('emits update metadata and retains merged descriptors on final artifacts', async () => {
    const task = makeTask();
    const events = await collect(
      makeExecutor(new DescribedMixedAgent()).executeStream(task, message),
    );
    const artifactEvents = events.filter(isArtifactEvent);

    const textUpdates = artifactEvents.filter((event) =>
      isTextPart(event.artifact.parts[0]),
    );
    expect(textUpdates.map((event) => event.metadata)).toEqual([
      { delivery: 'first' },
      { delivery: 'second' },
      undefined,
    ]);
    expect(textUpdates.at(-1)!.artifact).toMatchObject({
      name: 'result.txt',
      description: 'Consolidated result',
      metadata: {
        format: 'plain',
        confidence: 0.9,
        schema: { version: 1 },
      },
      extensions: [
        'https://example.com/extensions/base',
        'https://example.com/extensions/confidence',
      ],
      parts: [{ text: 'hello world' }],
    });

    const fileUpdate = artifactEvents.find((event) =>
      isFilePart(event.artifact.parts[0]),
    )!;
    expect(fileUpdate.metadata).toEqual({ delivery: 'file' });
    expect(fileUpdate.artifact.metadata).toEqual({ format: 'json' });

    const dataUpdate = artifactEvents.find((event) =>
      isDataPart(event.artifact.parts[0]),
    )!;
    expect(dataUpdate.metadata).toEqual({ delivery: 'data' });
    expect(dataUpdate.artifact.metadata).toEqual({ format: 'summary' });

    const terminalTextArtifact = task.artifacts!.find((artifact) =>
      isTextPart(artifact.parts[0]),
    );
    expect(terminalTextArtifact).toEqual(textUpdates.at(-1)!.artifact);
  });

  it('snapshots nested artifact and update metadata when the agent yields', async () => {
    class MutatingMetadataAgent extends BaseAgent {
      async *run(): AsyncGenerator<AgentEvent> {
        const artifactDetails = { version: 1 };
        const updateDetails = { sequence: 1 };
        yield {
          type: 'text',
          text: 'first',
          artifact: { metadata: { details: artifactDetails } },
          deliveryMetadata: { details: updateDetails },
        };
        artifactDetails.version = 2;
        updateDetails.sequence = 2;
        yield { type: 'text', text: 'second' };
        yield { type: 'done' };
      }
    }

    const task = makeTask();
    const events = await collect(
      makeExecutor(
        new MutatingMetadataAgent({ name: 'mutating-metadata' }),
      ).executeStream(task, message),
    );
    const textUpdates = events
      .filter(isArtifactEvent)
      .filter((event) => isTextPart(event.artifact.parts[0]));

    expect(textUpdates[0].artifact.metadata).toEqual({
      details: { version: 1 },
    });
    expect(textUpdates[0].metadata).toEqual({
      details: { sequence: 1 },
    });
    expect(textUpdates.at(-1)!.artifact.metadata).toEqual({
      details: { version: 1 },
    });
    expect(task.artifacts![0].metadata).toEqual({
      details: { version: 1 },
    });
  });

  it('ends a stream as failed when text artifact descriptors conflict', async () => {
    class ConflictingDescriptorAgent extends BaseAgent {
      async *run(): AsyncGenerator<AgentEvent> {
        yield {
          type: 'text',
          text: 'kept',
          artifact: { name: 'first.txt' },
        };
        yield {
          type: 'text',
          text: 'discarded',
          artifact: { name: 'second.txt' },
        };
      }
    }

    const task = makeTask();
    const events = await collect(
      makeExecutor(
        new ConflictingDescriptorAgent({ name: 'conflict' }),
      ).executeStream(task, message),
    );

    expect(events.filter(isArtifactEvent)).toHaveLength(1);
    const finalEvent = events.at(-1)!;
    expect('status' in finalEvent && finalEvent.status.state).toBe(
      TaskState.FAILED,
    );
    expect(task.status.message?.parts).toEqual([
      { text: 'Conflicting text artifact name' },
    ]);
    expect(task.artifacts).toMatchObject([
      { name: 'first.txt', parts: [{ text: 'kept' }] },
    ]);
  });

  it('uses distinct artifactIds for multiple non-text events in a single run', async () => {
    class MultiFileAgent extends BaseAgent {
      constructor() {
        super({ name: 'multi-file' });
      }
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'file', file: { url: 'a.png' } };
        yield { type: 'file', file: { url: 'b.png' } };
        yield { type: 'done' };
      }
    }

    const task = makeTask();
    const events = await collect(
      makeExecutor(new MultiFileAgent()).executeStream(task, message),
    );

    const artifactIds = events
      .filter(isArtifactEvent)
      .map((e) => e.artifact.artifactId);
    expect(new Set(artifactIds).size).toBe(artifactIds.length);
  });
});
