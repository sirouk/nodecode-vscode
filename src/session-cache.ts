// Local acceleration only: Nodecode's durable history remains authoritative.
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { StoreProjection } from "./store";

export interface HistoryWitness { sequence: number; eventId: string }
export interface SessionCheckpoint {
  version: 1;
  sessionId: string;
  home: string;
  cursor: number;
  witness?: HistoryWitness;
  projection: StoreProjection;
}

export class SessionCache {
  private readonly file: string | undefined;
  private readonly home: string;

  constructor(storageRoot: string | undefined, private readonly sessionId: string, private readonly log: (message: string) => void) {
    const home = path.resolve(process.env.NODECODE_HOME || path.join(os.homedir(), ".nodecode"));
    try { this.home = fs.realpathSync(home); } catch { this.home = home; }
    if (storageRoot) {
      const key = createHash("sha256").update(JSON.stringify([this.home, sessionId])).digest("hex");
      this.file = path.join(storageRoot, "session-cache", `${key}.json`);
    }
  }

  load(): SessionCheckpoint | undefined {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as SessionCheckpoint;
      if (saved.version !== 1 || saved.home !== this.home || saved.sessionId !== this.sessionId ||
          !Number.isSafeInteger(saved.cursor) || saved.cursor < 0 || !saved.projection ||
          (saved.cursor > 0 && saved.projection.lastSequence > saved.cursor) ||
          (saved.witness && (!Number.isSafeInteger(saved.witness.sequence) || saved.witness.sequence <= 0 ||
            saved.witness.sequence > saved.cursor || saved.witness.sequence > saved.projection.lastSequence || typeof saved.witness.eventId !== "string"))) {
        throw new Error("Invalid session checkpoint");
      }
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log(`session cache ignored: ${String(error)}`);
      return;
    }
  }

  save(cursor: number, witness: HistoryWitness | undefined, projection: StoreProjection): void {
    if (!this.file) return;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const checkpoint: SessionCheckpoint = { version:1, sessionId:this.sessionId, home:this.home, cursor, witness, projection };
      fs.writeFileSync(temporary, JSON.stringify(checkpoint), { mode:0o600, flag:"wx" });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      this.log(`session cache write failed: ${String(error)}`);
      try { fs.unlinkSync(temporary); } catch { /* No completed checkpoint was replaced. */ }
    }
  }

  remove(): void {
    if (!this.file) return;
    try { fs.unlinkSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log(`session cache removal failed: ${String(error)}`); }
  }
}
