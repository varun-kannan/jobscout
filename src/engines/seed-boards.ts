/**
 * A starter set of company boards.
 *
 * ATS engines poll named companies, so a fresh install with no boards discovers
 * nothing from the strongest family in the roster. This list gives `jobscout
 * init` something real to work with on day one; board discovery (phase 7)
 * expands it, and `jobscout boards` lets you curate it by hand.
 *
 * Every token here was resolved against the live API before being added.
 * Companies move between platforms, so a token that stops resolving is dropped
 * by the next `jobscout init` rather than failing quietly forever.
 */

import type { Board } from "./engine.ts";

export const SEED_BOARDS: readonly Board[] = [
  // ── Greenhouse ────────────────────────────────────────────
  { company: "Stripe", ats: "greenhouse", token: "stripe" },
  { company: "Postman", ats: "greenhouse", token: "postman" },
  { company: "Groww", ats: "greenhouse", token: "groww" },

  // ── Lever ─────────────────────────────────────────────────
  { company: "Meesho", ats: "lever", token: "meesho" },
  { company: "CRED", ats: "lever", token: "cred" },

  // ── Ashby ─────────────────────────────────────────────────
  { company: "Ramp", ats: "ashby", token: "ramp" },

  // ── Recruitee ─────────────────────────────────────────────
  { company: "Hygraph", ats: "recruitee", token: "hygraph" },
];
