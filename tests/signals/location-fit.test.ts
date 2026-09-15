import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FIT, locationFitSql } from "../../src/signals/location-fit.ts";

/** Evaluate the expression the way listJobs will, against a one-row table. */
function fit(location: string | null, remote: number | null, preferred: string[]): number {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE jobs (location TEXT, remote INTEGER)`);
  db.prepare(`INSERT INTO jobs VALUES (?, ?)`).run(location, remote);
  const { sql, params } = locationFitSql(preferred)!;
  const row = db.query<{ fit: number }, string[]>(`SELECT ${sql} AS fit FROM jobs j`).get(...params)!;
  db.close();
  return row.fit;
}

const CHENNAI = ["Chennai"];

describe("locationFitSql", () => {
  test("a posting in one of your locations ranks first", () => {
    expect(fit("Chennai, Tamil Nadu, India", 0, CHENNAI)).toBe(FIT.preferred);
    expect(fit("CHENNAI", null, CHENNAI)).toBe(FIT.preferred);
  });

  test("any of several locations counts", () => {
    expect(fit("Coimbatore", 0, ["Chennai", "Coimbatore"])).toBe(FIT.preferred);
  });

  test("an unrestricted remote role is open to you", () => {
    expect(fit("Remote", 1, CHENNAI)).toBe(FIT.remoteOpen);
    expect(fit("Remote job", null, CHENNAI)).toBe(FIT.remoteOpen);
  });

  test("a remote role that names a region including India is open", () => {
    expect(fit("Remote - India", 1, CHENNAI)).toBe(FIT.remoteOpen);
    expect(fit("Remote (APAC)", 1, CHENNAI)).toBe(FIT.remoteOpen);
    expect(fit("Remote (Worldwide)", 1, CHENNAI)).toBe(FIT.remoteOpen);
  });

  /** The engines put the restriction in the location text, not a column. */
  test("a remote role restricted to another region is elsewhere", () => {
    for (const where of [
      "Remote (USA)", "REMOTE (US only)", "Remote - United States", "Remote - Europe",
      "Cardiff, London or Remote (UK)", "United States, Remote", "Remote - US",
    ]) {
      expect(fit(where, 1, CHENNAI)).toBe(FIT.elsewhere);
    }
  });

  test("a region that includes India outweighs one that does not", () => {
    expect(fit("Remote - India or US", 1, CHENNAI)).toBe(FIT.remoteOpen);
  });

  /** "us" inside another word must not count as the United States. */
  test("short region codes do not match inside other words", () => {
    expect(fit("Remote - Russia friendly", 1, CHENNAI)).toBe(FIT.remoteOpen);
  });

  test("a posting that does not say where it is sits in the middle", () => {
    expect(fit("N/A", null, CHENNAI)).toBe(FIT.unstated);
    expect(fit(null, null, CHENNAI)).toBe(FIT.unstated);
    expect(fit("  ", null, CHENNAI)).toBe(FIT.unstated);
  });

  test("an on-site role somewhere else ranks last", () => {
    expect(fit("Seattle", 0, CHENNAI)).toBe(FIT.elsewhere);
    expect(fit("Bengaluru, Karnataka, India", 0, CHENNAI)).toBe(FIT.elsewhere);
  });

  test("your own location wins even when the text also says remote", () => {
    expect(fit("Chennai or Remote (US)", 1, CHENNAI)).toBe(FIT.preferred);
  });

  /** With nothing preferred there is nothing to sort by, and no term to add. */
  test("no preferred locations gives no expression", () => {
    expect(locationFitSql([])).toBeNull();
    expect(locationFitSql(["  ", ""])).toBeNull();
  });

  test("LIKE wildcards in a location you typed are matched literally", () => {
    expect(fit("100% city", 0, ["100%"])).toBe(FIT.preferred);
    expect(fit("10 city", 0, ["1_0"])).toBe(FIT.elsewhere);
  });

  test("a quote in a location cannot break the query", () => {
    expect(() => fit("O'Hare", 0, ["O'Hare"])).not.toThrow();
    expect(fit("O'Hare", 0, ["O'Hare"])).toBe(FIT.preferred);
  });
});
