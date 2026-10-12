export default function Home() {
  return (
    <div style={{ display: "flex", height: "100vh", background: "#2b2d31", color: "#fff" }}>
      <aside style={{ width: 240, background: "#1e1f22", padding: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Waicord</h1>
        <nav style={{ marginTop: 24 }}>
          <p style={{ color: "#b5b5b5" }}># general</p>
        </nav>
      </aside>
      <main style={{ flex: 1, padding: 16 }}>
        <p style={{ color: "#949494" }}>Чат в разработке</p>
      </main>
    </div>
  );
}
