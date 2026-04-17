# NestJS

Module, Controller, and Service setup for A2A protocol integration using `@a2x/sdk` in NestJS projects.

---

## Directory Structure

```
src/
├── a2a/
│   ├── a2a.module.ts         # A2A feature module
│   ├── a2a.controller.ts     # Route handlers
│   └── a2a.service.ts        # A2X setup and business logic
├── app.module.ts             # Root module (imports A2aModule)
└── main.ts                   # Bootstrap
```

---

## A2A Service

`src/a2a/a2a.service.ts`:

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  LlmAgent,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  A2XAgent,
  DefaultRequestHandler,
  createSSEStream,
} from '@a2x/sdk';
import type { RequestContext } from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';
// Or: import { AnthropicProvider } from '@a2x/sdk/anthropic';
// Or: import { OpenAIProvider } from '@a2x/sdk/openai';

@Injectable()
export class A2aService implements OnModuleInit {
  private handler!: DefaultRequestHandler;
  private a2xAgent!: A2XAgent;

  onModuleInit() {
    const agent = new LlmAgent({
      name: 'my-agent',
      description: 'A helpful AI agent.',
      provider: new GoogleProvider({
        model: 'gemini-2.5-flash',
        apiKey: process.env.GOOGLE_API_KEY!,
      }),
      instruction: 'You are a helpful assistant.',
    });

    const runner = new InMemoryRunner({ agent, appName: agent.name });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
    });
    const taskStore = new InMemoryTaskStore();

    this.a2xAgent = new A2XAgent({ taskStore, executor, protocolVersion: '1.0' })
      .setDefaultUrl(`${process.env.BASE_URL ?? 'http://localhost:3000'}/a2a`)
      .addSkill({
        id: 'chat',
        name: 'General Chat',
        description: 'General conversation and Q&A',
        tags: ['chat', 'general'],
      });

    this.handler = new DefaultRequestHandler(this.a2xAgent);
  }

  getAgentCard() {
    return this.handler.getAgentCard();
  }

  async handleRequest(body: unknown, context: RequestContext) {
    return this.handler.handle(body, context);
  }

  createSSEStream(generator: AsyncGenerator) {
    return createSSEStream(generator);
  }
}
```

---

## A2A Controller

`src/a2a/a2a.controller.ts`:

```typescript
import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RequestContext } from '@a2x/sdk';
import { A2aService } from './a2a.service';

@Controller()
export class A2aController {
  constructor(private readonly a2aService: A2aService) {}

  @Get('.well-known/agent.json')
  getAgentCard(@Res() res: Response) {
    try {
      const card = this.a2aService.getAgentCard();
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json(card);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }

  @Post('a2a')
  async handleA2a(@Req() req: Request, @Res() res: Response) {
    // Build RequestContext for authentication
    const context: RequestContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      query: req.query as Record<string, string | string[] | undefined>,
    };

    try {
      const result = await this.a2aService.handleRequest(req.body, context);

      // Streaming → SSE
      if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const stream = this.a2aService.createSSEStream(result as AsyncGenerator);
        const reader = stream.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(typeof value === 'string' ? value : new TextDecoder().decode(value));
          }
        } catch (error) {
          const errorData = JSON.stringify({
            error: error instanceof Error ? error.message : 'Internal error',
          });
          res.write(`event: error\ndata: ${errorData}\n\n`);
        }
        res.end();
        return;
      }

      // Synchronous → JSON
      res.json(result);
    } catch {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
  }
}
```

---

## A2A Module

`src/a2a/a2a.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { A2aController } from './a2a.controller';
import { A2aService } from './a2a.service';

@Module({
  controllers: [A2aController],
  providers: [A2aService],
  exports: [A2aService],
})
export class A2aModule {}
```

---

## Register in App Module

`src/app.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { A2aModule } from './a2a/a2a.module';

@Module({
  imports: [A2aModule],
})
export class AppModule {}
```

---

## NestJS-Specific Notes

### Using @Res() with Streaming

When using `@Res()` decorator, NestJS delegates response handling to you. This is required for SSE streaming since NestJS doesn't natively support `AsyncGenerator` responses from controllers.

### ConfigService for Environment Variables

For a more NestJS-idiomatic approach, inject `ConfigService`:

```typescript
import { ConfigService } from '@nestjs/config';

@Injectable()
export class A2aService {
  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.getOrThrow<string>('GOOGLE_API_KEY');
    const baseUrl = this.configService.get<string>('BASE_URL', 'http://localhost:3000');
    // ...
  }
}
```

Requires `@nestjs/config`:

```bash
npm install @nestjs/config
```

```typescript
// app.module.ts
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    A2aModule,
  ],
})
export class AppModule {}
```

### CORS

Enable CORS in `main.ts`:

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(3000);
}
```

### Raw Body Access

NestJS parses JSON bodies by default via Express middleware, so `req.body` is already available as a parsed object.
