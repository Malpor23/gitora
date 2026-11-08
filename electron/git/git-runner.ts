import { spawn } from 'node:child_process';
import type { CommandLogEntry, ProgressEvent } from '@core/models';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly stdout: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface RunOptions {
  cwd: string;
  /** Texto a enviar por stdin (p. ej. un parche para `git apply`). */
  input?: string;
  env?: Record<string, string>;
  /** Id para emitir eventos de progreso (clone, fetch, push, pull). */
  progressId?: string;
  /** No registrar en la consola (lecturas muy frecuentes como status). */
  silent?: boolean;
  /** Códigos de salida que no son error (p. ej. `git diff --no-index` devuelve 1). */
  okCodes?: number[];
  /** Configuración extra `-c clave=valor` (autenticación por cabecera, etc.). */
  config?: string[];
  timeoutMs?: number;
}

type Listener<T> = (payload: T) => void;

/**
 * Ejecuta el binario git del sistema sin pasar por una shell (sin inyección de
 * comandos) y registra cada ejecución para la consola de actividad.
 */
export class GitRunner {
  private seq = 0;
  private readonly history: CommandLogEntry[] = [];
  private logListeners: Listener<CommandLogEntry>[] = [];
  private progressListeners: Listener<ProgressEvent>[] = [];

  private gitPath: string;

  constructor(gitPath?: string) {
    this.gitPath = gitPath || 'git'; // vacío en ajustes = git del PATH
  }

  setGitPath(path: string) {
    this.gitPath = path || 'git';
  }

  onLog(fn: Listener<CommandLogEntry>) {
    this.logListeners.push(fn);
  }

  onProgress(fn: Listener<ProgressEvent>) {
    this.progressListeners.push(fn);
  }

  getHistory(): CommandLogEntry[] {
    return [...this.history];
  }

  /** Opciones globales que hacen la salida estable y parseable. */
  private baseArgs(config: string[] = []): string[] {
    const base = [
      '-c', 'core.quotepath=false',
      '-c', 'color.ui=false',
      '-c', 'core.pager=cat',
      '-c', 'i18n.logOutputEncoding=utf-8',
    ];
    for (const c of config) base.push('-c', c);
    return base;
  }

  run(args: string[], opts: RunOptions): Promise<string> {
    const entry: CommandLogEntry = {
      id: ++this.seq,
      repo: opts.cwd,
      args,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      exitCode: null,
      output: '',
      error: '',
      running: true,
    };
    const started = Date.now();
    if (!opts.silent) this.emitLog(entry);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.gitPath, [...this.baseArgs(opts.config), ...args], {
        cwd: opts.cwd,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',       // nunca bloquear esperando credenciales en una TTY
          GIT_OPTIONAL_LOCKS: '0',        // status no debe bloquear otras herramientas
          GCM_INTERACTIVE: 'auto',        // Git Credential Manager (Windows) puede mostrar su UI
          LANG: 'en_US.UTF-8',            // mensajes en inglés para poder interpretarlos
          LANGUAGE: 'en',
          ...opts.env,
        },
      });

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => child.kill(), opts.timeoutMs);
      }

      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => {
        err.push(d);
        if (opts.progressId) this.parseProgress(opts.progressId, d.toString('utf8'));
      });

      child.on('error', (e: NodeJS.ErrnoException) => {
        if (timer) clearTimeout(timer);
        const msg = e.code === 'ENOENT'
          ? `No se encontró git en "${this.gitPath}". Instálalo o configura la ruta en Ajustes.`
          : e.message;
        entry.running = false;
        entry.error = msg;
        entry.durationMs = Date.now() - started;
        if (!opts.silent) this.emitLog(entry);
        reject(new GitError(msg, args, null, msg, ''));
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        entry.running = false;
        entry.exitCode = code;
        entry.durationMs = Date.now() - started;
        entry.output = truncate(stdout);
        entry.error = truncate(cleanProgress(stderr));
        if (!opts.silent) this.emitLog(entry);

        const ok = code === 0 || (code !== null && opts.okCodes?.includes(code));
        if (ok) {
          resolve(stdout);
        } else {
          const message = friendlyError(stderr || stdout) || `git ${args[0]} terminó con código ${code}`;
          reject(new GitError(message, args, code, stderr, stdout));
        }
      });

      if (opts.input !== undefined) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    });
  }

  private emitLog(entry: CommandLogEntry) {
    const copy = { ...entry };
    if (!entry.running) {
      this.history.push(copy);
      if (this.history.length > 500) this.history.shift();
    }
    for (const fn of this.logListeners) fn(copy);
  }

  private parseProgress(id: string, chunk: string) {
    // git separa las actualizaciones de progreso con \r
    for (const piece of chunk.split(/[\r\n]+/)) {
      const raw = piece.trim();
      if (!raw) continue;
      const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/.exec(raw);
      const evt: ProgressEvent = {
        id,
        phase: m ? m[1].trim() : raw.replace(/^remote: /, ''),
        percent: m ? +m[2] : null,
        raw,
      };
      for (const fn of this.progressListeners) fn(evt);
    }
  }
}

function truncate(s: string, max = 20000): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} caracteres más)` : s;
}

/** Quita las líneas intermedias de progreso (con \r) para que la consola quede limpia. */
function cleanProgress(s: string): string {
  return s
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      return parts[parts.length - 1];
    })
    .join('\n');
}

function friendlyError(text: string): string {
  const lines = cleanProgress(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^hint:/i.test(l));
  const fatal = lines.find((l) => /^(fatal|error):/i.test(l));
  return (fatal ?? lines.slice(-3).join('\n')).replace(/^(fatal|error):\s*/i, '');
}
