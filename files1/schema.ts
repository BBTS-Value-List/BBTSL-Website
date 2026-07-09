import { pgTable, serial, text, integer, boolean } from "drizzle-orm/pg-core";

export const swords = pgTable("swords", {
  id: serial("id").primaryKey(),
  n: text("n").notNull(),        // name
  c: text("c").notNull(),        // category
  v: integer("v").notNull(),     // value
  d: text("d").notNull(),        // demand
  t: text("t").notNull(),        // trend
  ct: integer("ct"),             // trade count (nullable)
  u: text("u").notNull(),        // last updated (YYYY-MM-DD)
  desc: text("desc").default(""),
  img: text("img"),              // base64 data URL, nullable
  edited: boolean("edited").default(false),
});
