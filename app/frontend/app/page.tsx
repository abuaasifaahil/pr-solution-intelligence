export default function Home() {
  return (
    <main style={{ padding: '48px', maxWidth: 800 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        PR Solution Intelligence
      </h1>
      <p style={{ color: '#616161' }}>
        M1 — Foundation Core. Visit{' '}
        <code style={{ background: '#EBF3FE', padding: '2px 6px', borderRadius: 4 }}>
          /api/healthz
        </code>{' '}
        to verify the frontend is alive.
      </p>
    </main>
  );
}
