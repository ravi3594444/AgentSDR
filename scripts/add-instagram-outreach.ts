import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = new SQL(url, {
  max: 1,
  tls:
    process.env.DATABASE_SSL === "disable"
      ? false
      : { rejectUnauthorized: false },
});
try {
  const ddl = await readFile(
    join(import.meta.dir, "../db/migrations/20261017-instagram-outreach.sql"),
    "utf8",
  );
  await db.begin(async (tx) => {
    await tx.unsafe(ddl).simple();
  });
  console.log(
    "Instagram outbound schema ready. Existing messages and plans were preserved.",
  );
} finally {
  await db.close();
}
