#!/usr/bin/env bash
# Builds the Linux release artifacts and writes checksums plus a manifest.
#
#   scripts/release.sh              # full check + deb + AppImage
#   scripts/release.sh --skip-check # skip make check (use only if it just ran)
#
# Signing: set MAPPA_GPG_KEY to a key id, or have exactly one secret key in
# the default keyring. Without a key the script still produces SHA256SUMS and
# prints the command to sign it later.
set -euo pipefail

cd "$(dirname "$0")/.."
# tauri-cli shells out to cargo, which may live outside PATH in non-login shells.
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

skip_check=0
[[ ${1:-} == "--skip-check" ]] && skip_check=1

version=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
out=dist/release
mkdir -p "$out"
rm -f "$out"/*.deb "$out"/*.AppImage "$out"/SHA256SUMS "$out"/SHA256SUMS.asc "$out"/manifest.json

if [[ $skip_check == 0 ]]; then
  echo "== make check"
  make check
fi

echo "== tauri build ($version)"
# Old bundles from a previous version would win the "newest" lookup below.
rm -rf target/release/bundle/deb target/release/bundle/appimage
./ui/node_modules/.bin/tauri build --bundles deb,appimage

echo "== collecting artifacts"
deb=$(find target/release/bundle/deb -name "Mappa_${version}_*.deb" -print -quit)
appimage=$(find target/release/bundle/appimage -name "Mappa_${version}_*.AppImage" -print -quit 2>/dev/null || true)
[[ -n $deb ]] || { echo "no .deb produced" >&2; exit 1; }
cp "$deb" "$out/"
if [[ -n $appimage ]]; then
  cp "$appimage" "$out/"
else
  echo "warning: no AppImage produced (bundler missing?)" >&2
fi

echo "== checksums"
(cd "$out" && sha256sum ./*.deb ./*.AppImage >SHA256SUMS)

echo "== manifest"
OUT="$out" VERSION="$version" python3 - <<'PY'
import datetime, hashlib, json, os, pathlib, subprocess

out = pathlib.Path(os.environ['OUT'])
commit = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
files = []
for path in sorted(out.iterdir()):
    if path.suffix not in {'.deb', '.AppImage'}:
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    files.append({'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest})
manifest = {
    'name': 'Mappa',
    'version': os.environ['VERSION'],
    'commit': commit,
    'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'platform': 'linux-amd64',
    'artifacts': files,
}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f"{len(files)} artifacts, {sum(f['bytes'] for f in files) / 1048576:.2f} MiB")
PY

if [[ -n ${MAPPA_GPG_KEY:-} ]]; then
  echo "== signing with $MAPPA_GPG_KEY"
  gpg --batch --yes --local-user "$MAPPA_GPG_KEY" --armor --detach-sign \
    --output "$out/SHA256SUMS.asc" "$out/SHA256SUMS"
elif gpg --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec'; then
  echo "== signing with the default GPG key"
  gpg --batch --yes --armor --detach-sign --output "$out/SHA256SUMS.asc" "$out/SHA256SUMS"
else
  cat <<'TXT'
warning: no GPG secret key found, checksums are not signed.
  Create a release key, then sign:
    gpg --quick-generate-key "Mappa release <release@example.invalid>" ed25519 sign 2y
    gpg --armor --detach-sign --output dist/release/SHA256SUMS.asc dist/release/SHA256SUMS
TXT
fi

echo
echo "artifacts in $out:"
ls -lh "$out"
