export default function Home() {
  return (
    <main className="container mx-auto max-w-3xl p-8 space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">
          a2x x402 Agent-Driven Sample
        </h1>
        <p className="mt-2 text-gray-600">
          The agent itself decides — at runtime, based on which tool it&apos;s
          about to call — whether the request requires payment. The
          decision is yielded as an{' '}
          <code className="font-mono">AgentEvent</code> from inside{' '}
          <code className="font-mono">BaseAgent.run()</code> and a custom
          executor converts it into a standalone-flow{' '}
          <code className="font-mono">payment-required</code> task.
        </p>
      </header>

      <section>
        <h2 className="text-xl font-semibold">How the gate works</h2>
        <ol className="mt-2 list-decimal list-inside space-y-1 text-gray-700">
          <li>
            Custom <code className="font-mono">AgentDrivenX402Executor</code>{' '}
            runs the agent without any pre-flight predicate.
          </li>
          <li>
            Agent classifies the user request. Free path → emits{' '}
            <code className="font-mono">text</code> +{' '}
            <code className="font-mono">done</code> as usual.
          </li>
          <li>
            Premium path → agent yields a sentinel{' '}
            <code className="font-mono">data</code> AgentEvent (mediaType{' '}
            <code className="font-mono">application/vnd.a2x.sample.x402.payment-required+json</code>)
            carrying the payment <code className="font-mono">accepts</code>.
          </li>
          <li>
            Executor catches the sentinel, aborts further agent execution,
            and emits <code className="font-mono">input-required</code>{' '}
            with the standard{' '}
            <code className="font-mono">x402.payment.required</code>{' '}
            metadata.
          </li>
          <li>
            Client signs and resubmits. Executor verifies + settles via
            the facilitator, sets{' '}
            <code className="font-mono">session.state.__x402_payment_settled = true</code>,
            and re-runs the agent. The agent reads that flag, skips the
            sentinel, and runs the paid tool for real.
          </li>
        </ol>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Try it</h2>
        <p className="mt-2 text-gray-600 text-sm">
          Free tier — agent runs <code className="font-mono">lookup_word</code>{' '}
          and finishes:
        </p>
        <pre className="mt-2 rounded bg-gray-100 p-3 text-xs overflow-x-auto">
{`a2x a2a send http://localhost:3000/api/a2a "define ephemeral"`}
        </pre>
        <p className="mt-4 text-gray-600 text-sm">
          Premium tier — agent decides{' '}
          <code className="font-mono">deep_translate</code> is the right
          tool, yields the sentinel, executor turns it into{' '}
          <code className="font-mono">payment-required</code>:
        </p>
        <pre className="mt-2 rounded bg-gray-100 p-3 text-xs overflow-x-auto">
{`# Create and select a wallet
a2x wallet create
a2x wallet use default

# Fund with Base Sepolia USDC at https://faucet.circle.com

# CLI runs the full x402 dance — the resubmit triggers the paid tool.
a2x a2a send http://localhost:3000/api/a2a "translate hello to korean"`}
        </pre>
      </section>
    </main>
  );
}
