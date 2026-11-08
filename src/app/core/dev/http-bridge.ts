import type { PathPickRequest, PathPickResult } from './path-picker/path-picker';

type Listener = (payload: unknown) => void;

async function call(kind: 'git' | 'app', op: string, args: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`/api/${kind}/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    });
  } catch {
    throw new Error(
      'No se pudo conectar con el servidor de desarrollo. Ejecuta `npm run start:web`.',
    );
  }
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; message?: string };
  if (!res.ok) {
    if (!body.message && [404, 502, 503, 504].includes(res.status)) {
      throw new Error(
        'Servidor de desarrollo no disponible. Ejecuta `npm run start:web` (o `npm run dev:server` junto a `ng serve`).',
      );
    }
    throw new Error(body.message ?? `Error ${res.status}`);
  }
  return body.result;
}

type PathPicker = (req: PathPickRequest) => Promise<PathPickResult | null>;
let pathPicker: PathPicker | null = null;

/** Registra el selector de rutas propio (modal); sin él se cae a window.prompt. */
export function setPathPicker(fn: PathPicker) {
  pathPicker = fn;
}

export function installHttpBridge() {
  const listeners = new Map<string, Set<Listener>>();
  let source: EventSource | null = null;

  const dispatch = (event: string, payload: unknown) =>
    listeners.get(event)?.forEach((cb) => cb(payload));

  const ensureSource = (event: string) => {
    if (source || event === 'window-focus') return;
    source = new EventSource('/api/events');
    for (const name of ['command-log', 'progress', 'repo-changed']) {
      source.addEventListener(name, (e) =>
        dispatch(name, JSON.parse((e as MessageEvent<string>).data)),
      );
    }
  };

  window.addEventListener('focus', () => dispatch('window-focus', { focused: true }));

  // Los diálogos nativos no existen en el navegador: se piden por texto.
  const ask = (title: string) => window.prompt(`${title}\n(ruta absoluta)`)?.trim() || null;

  window.gitora = {
    git: (op, ...args) => call('git', op, args),
    app: async (op, ...args) => {
      switch (op) {
        case 'pickDirectory': {
          const title = String(args[0] ?? 'Carpeta');
          return pathPicker ? pathPicker({ mode: 'directory', title }) : ask(title);
        }
        case 'pickFiles': {
          const title = String(args[0] ?? 'Archivo');
          if (pathPicker) return (await pathPicker({ mode: 'files', title })) ?? [];
          const p = ask(title);
          return p ? [p] : [];
        }
        case 'pickSavePath': {
          const title = String(args[0] ?? 'Guardar como');
          const defaultName = String(args[1] ?? '');
          return pathPicker ? pathPicker({ mode: 'save', title, defaultName }) : ask(title);
        }
        case 'openExternal':
          if (/^https?:\/\//i.test(String(args[0])))
            window.open(String(args[0]), '_blank', 'noopener');
          return undefined;
        default:
          return call('app', op, args);
      }
    },
    on: (event, cb) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(cb);
      listeners.set(event, set);
      ensureSource(event);
      return () => set.delete(cb);
    },
  };
}
