import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const binaryArg = process.argv[2];
if (!binaryArg) {
  throw new Error('Usage: node scripts/smoke-x402-binary.mjs <binary>');
}

const binary = isAbsolute(binaryArg) ? binaryArg : resolve(binaryArg);
const privateKey = `0x${'11'.repeat(32)}`;
const extension = 'https://github.com/google-a2a/a2a-x402/v0.1';
const network = 'eip155:84532';
const taskRoot = await mkdtemp(join(tmpdir(), 'a2x-x402-smoke-'));
let paymentSubmitted = false;

function run(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${binary} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const server = createServer((request, response) => {
  if (request.method === 'GET') {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        protocolVersion: '0.3.0',
        name: 'x402 binary smoke agent',
        description: 'Local-only signing fixture',
        url: `http://127.0.0.1:${server.address().port}`,
        version: '1.0.0',
        capabilities: {},
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      }),
    );
    return;
  }

  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    const rpc = JSON.parse(body);
    const metadata = rpc.params?.message?.metadata ?? {};
    paymentSubmitted = metadata['x402.payment.status'] === 'payment-submitted';
    const timestamp = new Date().toISOString();
    const status = paymentSubmitted
      ? {
          state: 'completed',
          timestamp,
          message: {
            messageId: 'smoke-completed',
            role: 'agent',
            parts: [{ kind: 'text', text: 'standalone x402 signing completed' }],
            metadata: {
              'x402.payment.status': 'payment-completed',
              'x402.payment.receipts': [
                {
                  success: true,
                  transaction: `0x${'22'.repeat(32)}`,
                  network,
                },
              ],
            },
          },
        }
      : {
          state: 'input-required',
          timestamp,
          message: {
            messageId: 'smoke-required',
            role: 'agent',
            parts: [{ kind: 'text', text: 'payment required' }],
            metadata: {
              'x402.payment.status': 'payment-required',
              'x402.payment.required': {
                x402Version: 2,
                resource: { url: `http://127.0.0.1:${server.address().port}` },
                accepts: [
                  {
                    scheme: 'exact',
                    network,
                    amount: '1000',
                    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                    payTo: '0x2222222222222222222222222222222222222222',
                    maxTimeoutSeconds: 300,
                    extra: { name: 'USDC', version: '2' },
                  },
                ],
              },
            },
          },
        };
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          kind: 'task',
          id: 'smoke-task',
          contextId: 'smoke-context',
          status,
          artifacts: [],
          history: [],
        },
      }),
    );
  });
});

try {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  const env = {
    ...process.env,
    HOME: taskRoot,
    USERPROFILE: taskRoot,
    NO_COLOR: '1',
  };
  await run(['wallet', 'create', 'smoke', '--import', privateKey], env);
  const { stdout } = await run(
    [
      'a2a',
      'send',
      `http://127.0.0.1:${port}`,
      'Confirm the local smoke test.',
      `--header=X-A2A-Extensions:${extension}`,
      '--max-amount=10000',
      '--json',
    ],
    env,
  );
  if (!paymentSubmitted || !stdout.includes('standalone x402 signing completed')) {
    throw new Error(`Standalone CLI did not submit the signed payment\n${stdout}`);
  }
  process.stdout.write('Standalone x402 signing smoke test passed\n');
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(taskRoot, { recursive: true, force: true });
}
