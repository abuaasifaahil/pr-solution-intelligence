export default function Home() {
  return (
    <main className="p-12 max-w-3xl">
      <h1 className="text-3xl font-bold mb-2 text-text-primary">PR Solution Intelligence</h1>
      <p className="text-text-secondary">
        M1 — Foundation Core. Visit{' '}
        <code className="bg-win-blue-50 px-1.5 py-0.5 rounded-sm font-mono text-sm">/api/healthz</code>{' '}
        to verify the frontend is alive.
      </p>
    </main>
  );
}
