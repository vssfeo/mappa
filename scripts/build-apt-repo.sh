#!/usr/bin/env bash
# Builds a signed Debian/Ubuntu repository from local .deb files.
#
#   scripts/build-apt-repo.sh [output-dir] [deb ...]
#
# The result can be published as a static site (GitHub Pages, any web server)
# and used with:
#   deb [signed-by=/etc/apt/keyrings/mappa.asc] https://<host>/ stable main
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

out=${1:-dist/apt}
shift || true
debs=("$@")
if [[ ${#debs[@]} -eq 0 ]]; then
  mapfile -t debs < <(find dist/release -maxdepth 1 -name 'Mappa_*_amd64.deb' -print)
fi
if [[ ${#debs[@]} -eq 0 ]]; then
  echo "no .deb files found; build one with make release or pass paths" >&2
  exit 1
fi

rm -rf "$out"
mkdir -p "$out/pool/main/m/mappa" "$out/dists/stable/main/binary-amd64"

for deb in "${debs[@]}"; do
  cp "$deb" "$out/pool/main/m/mappa/"
done

echo "== Packages index"
(cd "$out" && dpkg-scanpackages --multiversion pool /dev/null >dists/stable/main/binary-amd64/Packages)
gzip -kf "$out/dists/stable/main/binary-amd64/Packages"

echo "== Release"
OUT="$out" python3 - <<'PY'
import datetime, hashlib, os, pathlib

out = pathlib.Path(os.environ['OUT'])
dist = out / 'dists' / 'stable'
files = []
for relative in ['main/binary-amd64/Packages', 'main/binary-amd64/Packages.gz']:
    path = dist / relative
    data = path.read_bytes()
    files.append((relative, len(data), hashlib.md5(data).hexdigest(),
                  hashlib.sha1(data).hexdigest(), hashlib.sha256(data).hexdigest()))

lines = [
    'Origin: Mappa',
    'Label: Mappa',
    'Suite: stable',
    'Codename: stable',
    'Architectures: amd64',
    'Components: main',
    'Description: Mappa offline map workstation',
    f"Date: {datetime.datetime.now(datetime.timezone.utc).strftime('%a, %d %b %Y %H:%M:%S UTC')}",
    'MD5Sum:',
]
lines += [f' {md5} {size} {name}' for name, size, md5, sha1, sha256 in files]
lines.append('SHA1:')
lines += [f' {sha1} {size} {name}' for name, size, md5, sha1, sha256 in files]
lines.append('SHA256:')
lines += [f' {sha256} {size} {name}' for name, size, md5, sha1, sha256 in files]
(dist / 'Release').write_text('\n'.join(lines) + '\n')
print('Release written', dist / 'Release')
PY

echo "== signing"
release="$out/dists/stable/Release"
if [[ -n ${MAPPA_GPG_PASSPHRASE:-} ]]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase "$MAPPA_GPG_PASSPHRASE" \
    --clearsign -o "$release.InRelease" "$release"
  gpg --batch --yes --pinentry-mode loopback --passphrase "$MAPPA_GPG_PASSPHRASE" \
    --armor --detach-sign -o "$release.gpg" "$release"
elif gpg --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec'; then
  gpg --batch --yes --clearsign -o "$release.InRelease" "$release"
  gpg --batch --yes --armor --detach-sign -o "$release.gpg" "$release"
else
  echo "warning: no GPG key; the repository is unsigned and apt will refuse it" >&2
fi

if [[ -f "$release.InRelease" ]]; then
  cp "$release.InRelease" "$out/dists/stable/InRelease"
fi
if [[ -f "$release.gpg" ]]; then
  cp "$release.gpg" "$out/dists/stable/Release.gpg"
fi

echo
echo "repository in $out"
echo "publish it so that https://<host>/dists/stable/Release is reachable,"
echo "then on the client:"
echo "  sudo install -d -m 0755 /etc/apt/keyrings"
echo "  sudo cp mappa-release.asc /etc/apt/keyrings/mappa.asc"
echo "  echo 'deb [signed-by=/etc/apt/keyrings/mappa.asc] https://<host>/ stable main' \\"
echo "    | sudo tee /etc/apt/sources.list.d/mappa.list"
echo "  sudo apt update && sudo apt install mappa"
