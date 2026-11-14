// The remote-access cell, as the extension carries it.
//
// The work of remote access is a cell: a loopback proxy behind `tailscale
// serve`, the pairing of the devices that come through it, and the port of its
// own that keeps 443 alone. This extension is a second door onto that cell --
// a panel that reads and drives it -- not a second implementation of it. The
// files here are the room's own, byte for byte, so a home that installs from
// this bundle and one that installs from the hub end up with the same cell.
//
// The copy here is what a home without the cell gets, and it is the only
// way this extension ever puts code anywhere: the files travel in the package,
// nothing is fetched, and the room's own copy stays byte for byte this one.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const REMOTE_CELL = "nodecode-web-remote";

/** The cell that serves the gateway's own page at /web/. Nodecode ships it; this bundle does not. */
export const WEB_CELL = "nodecode-web";

/** This home, the way the CLI resolves it. */
export function nodecodeHome(): string {
  return process.env.NODECODE_HOME || path.join(os.homedir(), ".nodecode");
}

/** Where a cell of NAME lives in HOME. */
export function cellFolder(home: string, name: string = REMOTE_CELL): string {
  return path.join(home, "cells", name);
}

export interface CellInstall {
  path: string;
  copied: boolean;
}

/**
 * Put the bundled cell into HOME's cells folder, unless it is already there.
 * Existing files are never overwritten: a home that has the cell -- from the
 * hub, or from an earlier install of this bundle -- keeps what it has.
 */
export function installBundledCell(extensionPath: string, home: string = nodecodeHome()): CellInstall {
  const source = path.join(extensionPath, "resources", "remote");
  const target = cellFolder(home);
  if (fs.existsSync(path.join(target, `${REMOTE_CELL}.asd`))) return { path: target, copied: false };
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
  }
  return { path: target, copied: true };
}

/**
 * Whether this home already has the web cell on disk. The cell is nodecode's
 * own and is installed by nodecode, never by this extension: the answer is what
 * decides between loading it (a gateway restart) and saying where it comes from.
 */
export function webCellInstalled(home: string = nodecodeHome()): boolean {
  return fs.existsSync(path.join(cellFolder(home, WEB_CELL), `${WEB_CELL}.asd`));
}
