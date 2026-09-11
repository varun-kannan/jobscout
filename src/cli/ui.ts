/**
 * `jobscout ui` — the local web UI.
 *
 * Serves on loopback and, unless told not to, opens a browser at it. Runs until
 * interrupted, because the page is meant to stay open while you work.
 */

import { defineCommand } from "citty";
import { getPaths } from "../config/paths.ts";
import { loadConfigOrDefault } from "../config/load.ts";
import { openAndMigrate } from "../db/db.ts";
import { createServer } from "../ui/server.ts";
import { c, hint, line } from "../output/theme.ts";

export const uiCommand = defineCommand({
  meta: { name: "ui", description: "Browse, read and triage in your browser" },
  args: {
    port: { type: "string", description: "Port to listen on (default: any free one)" },
    // Declared positively: citty reads a `no-`prefixed boolean as a negation,
    // so a flag named "no-open" would never parse as true.
    open: { type: "boolean", description: "Open a browser (--no-open to skip)", default: true },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const config = await loadConfigOrDefault(paths);
    const db = await openAndMigrate(paths.db);

    const port = Number(args.port ?? 0);
    const { url, stop } = createServer({
      db: db.raw,
      config,
      paths,
      port: Number.isFinite(port) ? port : 0,
    });

    line();
    line(`  ${c.green("jobscout ui")}  ${c.bold(url)}`);
    line(hint("  Reads the same database as the CLI. Press Ctrl+C to stop."));
    line();

    if (args.open !== false) {
      const opener =
        process.platform === "darwin" ? ["open", url]
        : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
      // A browser that will not open is not a reason to stop serving — the URL
      // is printed above and can be opened by hand.
      try {
        Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" });
      } catch {
        line(hint("  Could not open a browser automatically."));
      }
    }

    await new Promise<void>((resolve) => {
      const shutdown = () => {
        stop();
        db.close();
        line();
        line(hint("  Stopped."));
        resolve();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  },
});
