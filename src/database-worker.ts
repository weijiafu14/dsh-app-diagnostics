import { DatabaseSync } from "node:sqlite";
process.on("message", (workerData: any) => {
  try {
    const db = new DatabaseSync(workerData.path, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    const stmt = db.prepare(workerData.sql);
    stmt.setReadBigInts(true);
    const rows: unknown[] = [];
    let truncated = false;
    for (const row of stmt.iterate(...workerData.params)) {
      if (rows.length >= workerData.limit) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    const result = JSON.parse(
      JSON.stringify({ rows, truncated }, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
    db.close();
    process.send!({ ok: true, value: result });
  } catch (e) {
    process.send!({ ok: false, error: String((e as Error).message) });
  }

  process.disconnect();
});
