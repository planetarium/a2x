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

describe('AgentExecutor.execute — non-text AgentEvents', () => {
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
});

// ─── executeStream() (SSE) path ───

describe('AgentExecutor.executeStream — non-text AgentEvents', () => {
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

    // 2 text chunk updates (append=true) + 1 file + 1 data + 1 final text (append=false)
    expect(artifactEvents).toHaveLength(5);

    const appendUpdates = artifactEvents.filter((e) => e.append === true);
    expect(appendUpdates).toHaveLength(2);
    expect(appendUpdates.every((e) => isTextPart(e.artifact.parts[0]))).toBe(
      true,
    );

    const finalUpdates = artifactEvents.filter((e) => e.append === false);
    expect(finalUpdates).toHaveLength(3);

    // Final artifact set on task: 1 file + 1 data + 1 text = 3 artifacts.
    expect(task.artifacts).toHaveLength(3);
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
