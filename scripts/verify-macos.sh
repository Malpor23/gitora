#!/usr/bin/env bash
# Verifica los .dmg de macOS generados en release/: montaje, firma, arquitectura y arranque.
# Pensado para correr en un runner de macOS (usa hdiutil, codesign, lipo y spctl).
set -uo pipefail

cd "$(dirname "$0")/.."
host_arch="$(uname -m)"
failures=0

fail() {
  echo "::error::$1"
  failures=$((failures + 1))
}

shopt -s nullglob
dmgs=(release/*.dmg)
if [ ${#dmgs[@]} -eq 0 ]; then
  fail "No hay archivos .dmg en release/"
fi

for dmg in "${dmgs[@]}"; do
  echo "::group::Verificando $dmg"
  mnt="$(mktemp -d)"
  work="$(mktemp -d)"

  if ! hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mnt" >/dev/null; then
    fail "$dmg: no se pudo montar"
    echo "::endgroup::"
    continue
  fi

  app="$mnt/Gitora.app"
  bin="$app/Contents/MacOS/Gitora"

  [ -d "$app" ] || fail "$dmg: falta Gitora.app"
  [ -L "$mnt/Applications" ] || fail "$dmg: falta el acceso directo a Aplicaciones"

  # Arquitectura esperada según el nombre del archivo.
  case "$dmg" in
    *arm64*) expected="arm64" ;;
    *) expected="x86_64" ;;
  esac
  actual="$(lipo -archs "$bin" 2>/dev/null || true)"
  [ "$actual" = "$expected" ] || fail "$dmg: arquitectura '$actual', se esperaba '$expected'"

  # Firma: debe ser válida y ad-hoc (no hay certificado de Apple Developer).
  codesign --verify --deep --strict --verbose=2 "$app" || fail "$dmg: la firma no es válida"
  sig_info="$(codesign -dv --verbose=2 "$app" 2>&1 || true)"
  echo "$sig_info" | grep -E 'Identifier|Signature|TeamIdentifier|Format' || true
  echo "$sig_info" | grep -q 'Signature=adhoc' || fail "$dmg: la firma no es ad-hoc"

  # Gatekeeper: se espera que rechace la app (no está notarizada). Solo informativo.
  if spctl --assess --type execute --verbose=2 "$app" 2>&1; then
    echo "Gatekeeper acepta la app"
  else
    echo "Gatekeeper rechaza la app (esperado: no está notarizada)"
  fi

  # Prueba de arranque solo si la arquitectura coincide con la del runner.
  if [ "$actual" = "$host_arch" ]; then
    ditto "$app" "$work/Gitora.app"
    "$work/Gitora.app/Contents/MacOS/Gitora" >"$work/stdout.log" 2>&1 &
    pid=$!
    sleep 12
    if kill -0 "$pid" 2>/dev/null; then
      echo "La app sigue en ejecución tras 12 s"
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    else
      echo "--- salida de la app ---"
      tail -n 30 "$work/stdout.log"
      fail "$dmg: la app se cerró antes de 12 s"
    fi
  else
    echo "Arranque omitido: el runner es $host_arch y el binario $actual"
  fi

  hdiutil detach "$mnt" -quiet || true
  rm -rf "$work"
  echo "::endgroup::"
done

if [ "$failures" -gt 0 ]; then
  echo "Verificación de macOS fallida: $failures problema(s)"
  exit 1
fi
echo "Verificación de macOS correcta"
