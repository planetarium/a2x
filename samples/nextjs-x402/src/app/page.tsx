export default function Home() {
  return (
    <main className="container mx-auto max-w-3xl p-8 space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">
          a2x x402 Sample
        </h1>
        <p className="mt-2 text-gray-600">
          An A2A agent paywalled with the a2a-x402 v0.2 extension. Each
          call settles two charges on Base Sepolia: a 0.001 USDC browsing
          gate, then a per-item embedded checkout (0.05–0.12 USDC).
        </p>
      </header>

      <section>
        <h2 className="text-xl font-semibold">Endpoints</h2>
        <ul className="mt-2 space-y-1 font-mono text-sm">
          <li>
            <span className="text-gray-500">GET </span>
            <code>/.well-known/agent.json</code>
            <span className="text-gray-500"> — AgentCard</span>
          </li>
          <li>
            <span className="text-gray-500">POST </span>
            <code>/api/a2a</code>
            <span className="text-gray-500"> — JSON-RPC entry point</span>
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Try it</h2>
        <p className="mt-2 text-gray-600 text-sm">
          Use the <code className="font-mono">@a2x/cli</code>:
        </p>
        <pre className="mt-2 rounded bg-gray-100 p-3 text-xs overflow-x-auto">
{`# 1. Create a wallet
a2x wallet create
a2x wallet use default

# 2. Fund the wallet with Base Sepolia USDC (faucet: https://faucet.circle.com)

# 3. Call the agent — the CLI handles the full two-payment dance
a2x a2a send http://localhost:3000/api/a2a "sku-air-max"`}
        </pre>
      </section>
    </main>
  );
}
