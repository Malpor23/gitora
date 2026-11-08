export type FileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typechange'
  | 'ignored';

export interface FileChange {
  path: string;
  origPath?: string;
  kind: FileChangeKind;
  /** Código de dos letras de git (XY), útil para mostrar en tooltips. */
  code: string;
  submodule?: boolean;
}
