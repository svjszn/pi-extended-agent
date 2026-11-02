import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface RunProgressSnapshot {
  elapsedMs: number;
  outputTokens: number;
  estimated: boolean;
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;

/** Only counters live here; prompts, reasoning and tool arguments are never retained. */
export class RunProgressTracker {
  private startedAt: number | undefined;
  private completed = 0;
  private estimated = false;
  private characters = 0;
  private reported = 0;

  constructor(private readonly clock = () => performance.now()) {}

  begin() {
    // Automatic retries and queued continuations belong to the same run.
    if (this.startedAt !== undefined) return;
    this.reset();
    this.startedAt = this.clock();
  }

  reset() {
    this.startedAt = undefined;
    this.completed = 0;
    this.estimated = false;
    this.startMessage();
  }

  startMessage() { this.characters = 0; this.reported = 0; }

  update(delta: string, output: unknown) {
    if (this.startedAt === undefined) return;
    this.characters += delta.length;
    this.reported = count(output);
  }

  endMessage(message: Pick<AssistantMessage, "usage" | "content">) {
    if (this.startedAt === undefined) return;
    const output = count(message.usage?.output);
    if (output) this.completed += output;
    else {
      // Some providers never report usage, including for an interrupted stream.
      // Prefer counted deltas; inspect a non-streaming response only once.
      const characters = this.characters || message.content.reduce((sum, part) => {
        if (part.type === "text") return sum + part.text.length;
        if (part.type === "thinking") return sum + part.thinking.length;
        try { return sum + JSON.stringify(part.arguments).length; } catch { return sum; }
      }, 0);
      this.completed += Math.ceil(characters / 4);
      this.estimated ||= characters > 0;
    }
    this.startMessage();
  }

  addUsage(usage: { output: number } | undefined) {
    if (this.startedAt !== undefined) this.completed += count(usage?.output);
  }

  snapshot(): RunProgressSnapshot | undefined {
    if (this.startedAt === undefined) return undefined;
    return {
      elapsedMs: Math.max(0, this.clock() - this.startedAt),
      outputTokens: Math.min(Number.MAX_SAFE_INTEGER, this.completed + (this.reported || Math.ceil(this.characters / 4))),
      estimated: this.estimated || (!this.reported && this.characters > 0),
    };
  }
}
