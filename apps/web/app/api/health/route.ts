import { Pool } from "pg";

// 本エンドポイントはG0以前の「環境が実際に稼働しているか」の確認専用。
// 業務ロジックは含まない。DATABASE_URLへの実接続をSELECT 1で検証する。
export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  const result: { app: string; db: "ok" | "ng"; error?: string; latencyMs?: number } = {
    app: "ok",
    db: "ng",
  };

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Response.json({ ...result, error: "DATABASE_URL is not set" }, { status: 500 });
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query("SELECT 1");
    result.db = "ok";
    result.latencyMs = Date.now() - startedAt;
    return Response.json(result, { status: 200 });
  } catch (err) {
    return Response.json(
      { ...result, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await pool.end();
  }
}
