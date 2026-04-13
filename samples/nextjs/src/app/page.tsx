export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-center gap-12 py-32 px-16 bg-white dark:bg-black sm:items-start">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Sample A2A Agent
          </h1>
          <p className="text-lg text-zinc-500 dark:text-zinc-400">
            Powered by <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">a2x</span> SDK + Next.js
          </p>
        </div>

        <div className="flex flex-col gap-6 w-full">
          <h2 className="text-xl font-medium text-zinc-800 dark:text-zinc-200">
            A2A Endpoints
          </h2>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
              <span className="shrink-0 rounded bg-emerald-100 px-2 py-1 text-xs font-mono font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                GET
              </span>
              <code className="text-sm text-zinc-700 dark:text-zinc-300">
                /.well-known/agent.json
              </code>
              <span className="ml-auto text-sm text-zinc-400">Agent Card (discovery)</span>
            </div>
            <div className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
              <span className="shrink-0 rounded bg-blue-100 px-2 py-1 text-xs font-mono font-semibold text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                POST
              </span>
              <code className="text-sm text-zinc-700 dark:text-zinc-300">
                /api/a2a
              </code>
              <span className="ml-auto text-sm text-zinc-400">JSON-RPC 2.0</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 w-full">
          <h2 className="text-xl font-medium text-zinc-800 dark:text-zinc-200">
            Supported Methods
          </h2>
          <ul className="grid gap-2 text-sm text-zinc-600 dark:text-zinc-400 font-mono">
            <li className="rounded border border-zinc-200 dark:border-zinc-800 px-4 py-2">message/send</li>
            <li className="rounded border border-zinc-200 dark:border-zinc-800 px-4 py-2">message/stream</li>
            <li className="rounded border border-zinc-200 dark:border-zinc-800 px-4 py-2">tasks/get</li>
            <li className="rounded border border-zinc-200 dark:border-zinc-800 px-4 py-2">tasks/cancel</li>
          </ul>
        </div>

        <div className="flex flex-col gap-4 w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 p-6">
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Quick Test</h3>
          <pre className="overflow-x-auto text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">{`curl http://localhost:3000/.well-known/agent.json

curl -X POST http://localhost:3000/api/a2a \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "messageId": "msg-1",
        "role": "user",
        "parts": [{ "text": "Hello!" }]
      }
    }
  }'`}</pre>
        </div>
      </main>
    </div>
  );
}
