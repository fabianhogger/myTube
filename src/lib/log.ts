type Level = "info" | "warn" | "error";

const stamp = () => new Date().toISOString().slice(11, 19);

function emit(level: Level, stage: string, msg: string, extra?: unknown) {
  const line = `${stamp()} ${level === "info" ? " " : level === "warn" ? "!" : "x"} [${stage}] ${msg}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

/** Stage-tagged logger shared by scripts and route handlers. */
export function logger(stage: string) {
  return {
    info: (msg: string, extra?: unknown) => emit("info", stage, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", stage, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", stage, msg, extra),
    child: (sub: string) => logger(`${stage}:${sub}`),
  };
}

export type Log = ReturnType<typeof logger>;
