// Who gets the byline on a story. New stories written by the scraper are shared out among the active
// authors, chosen at random each time.
import { rows } from "../db.js";

export const DESK = "Wheelora Desk";

/** @returns {Promise<{id: number | null, name: string}>} the author to credit; the desk byline when nobody is active */
export async function pickAuthor() {
  const a = (
    await rows(
      `SELECT a.id, a.name FROM authors a WHERE a.active
       ORDER BY random() LIMIT 1`,
    )
  )[0];
  return a ?? { id: null, name: DESK };
}
