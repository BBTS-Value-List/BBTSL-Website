import type { Config } from "@netlify/functions";
import { drizzle } from "drizzle-orm/netlify-db";
import { eq } from "drizzle-orm";
import { swords } from "../../db/schema";
import { DEFAULT_SWORDS } from "../../db/seed";

const db = drizzle({ schema: { swords } });

// Set EDITOR_PASSWORD in Netlify's environment variables (Project configuration
// > Environment variables) so the password isn't only sitting in your front-end code.
// Falls back to the value below if the env var isn't set.
const EDITOR_PASSWORD = process.env.EDITOR_PASSWORD || "Bigkunfupandadihh";

function checkAuth(req: Request): boolean {
  return req.headers.get("x-editor-password") === EDITOR_PASSWORD;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async (req: Request) => {
  const url = new URL(req.url);
  // pathname looks like /api/swords or /api/swords/12 or /api/swords/reset
  const parts = url.pathname.split("/").filter(Boolean);
  const afterSwords = parts.slice(parts.indexOf("swords") + 1); // [] | ["12"] | ["reset"]

  try {
    // GET /api/swords -> list everything, visible to all visitors
    if (req.method === "GET" && afterSwords.length === 0) {
      let rows = await db.select().from(swords);
      if (rows.length === 0) {
        // First time the database is queried — seed it with the starting list.
        await db.insert(swords).values(DEFAULT_SWORDS.map((s) => ({ ...s, edited: false })));
        rows = await db.select().from(swords);
      }
      return json(rows);
    }

    // POST /api/swords/reset -> wipe edits, restore the original list
    if (req.method === "POST" && afterSwords[0] === "reset") {
      if (!checkAuth(req)) return json({ error: "Unauthorized" }, 401);
      await db.delete(swords);
      await db.insert(swords).values(
        DEFAULT_SWORDS.map((s) => ({ ...s, edited: false }))
      );
      return json({ ok: true });
    }

    // POST /api/swords -> add a new sword
    if (req.method === "POST" && afterSwords.length === 0) {
      if (!checkAuth(req)) return json({ error: "Unauthorized" }, 401);
      const body = await req.json();
      if (!body.n || typeof body.n !== "string") {
        return json({ error: "Name is required." }, 400);
      }
      const [row] = await db
        .insert(swords)
        .values({
          n: body.n,
          c: body.c || "Other Swords",
          v: Number(body.v) || 0,
          d: body.d || "N/A",
          t: body.t || "N/A",
          ct: body.ct === "" || body.ct === undefined ? null : Number(body.ct),
          u: todayISO(),
          desc: body.desc || "",
          img: body.img || null,
          edited: true,
        })
        .returning();
      return json(row, 201);
    }

    // PUT /api/swords/:id -> edit an existing sword
    if (req.method === "PUT" && afterSwords.length === 1 && afterSwords[0] !== "reset") {
      if (!checkAuth(req)) return json({ error: "Unauthorized" }, 401);
      const id = Number(afterSwords[0]);
      if (Number.isNaN(id)) return json({ error: "Invalid id" }, 400);
      const body = await req.json();

      const update: Record<string, unknown> = {
        n: body.n,
        c: body.c,
        v: Number(body.v) || 0,
        d: body.d,
        t: body.t,
        ct: body.ct === "" || body.ct === undefined ? null : Number(body.ct),
        u: todayISO(),
        desc: body.desc || "",
        edited: true,
      };
      // img is only present in the payload when it actually changed (see app.js)
      if (body.img !== undefined) update.img = body.img;

      const [row] = await db.update(swords).set(update).where(eq(swords.id, id)).returning();
      if (!row) return json({ error: "Sword not found" }, 404);
      return json(row);
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong on the server." }, 500);
  }
};

export const config: Config = {
  path: ["/api/swords", "/api/swords/*"],
};
