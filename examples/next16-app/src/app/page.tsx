export default function Home() {
  return (
    <main style={{ padding: 40, fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
      <h1>Hoplens example</h1>
      <p>
        Open <a href="/__hoplens">/__hoplens</a> to send requests to the API routes in <code>src/app/api</code> and
        watch their journey.
      </p>
    </main>
  );
}
