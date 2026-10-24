CARGO ?= $(HOME)/.cargo/bin/cargo
export PATH := $(dir $(CARGO)):$(PATH)
TAURI ?= ./ui/node_modules/.bin/tauri
DISPLAY_ENV ?= env -u WAYLAND_DISPLAY GDK_BACKEND=x11

.PHONY: run dev build deb deb-check cli test fmt fmt-check clippy unicode-check smoke bench bench-large bench-ui ui-install ui-dev ui-check check ci

run dev:
	$(DISPLAY_ENV) $(TAURI) dev --no-watch

build:
	$(TAURI) build --no-bundle

deb:
	$(TAURI) build --bundles deb

deb-check: deb
	@deb="$$(find target/release/bundle/deb -name '*.deb' -print -quit)"; \
	test -n "$$deb"; \
	dpkg-deb -c "$$deb" | grep -Eq ' \./usr/bin/mappa$$'; \
	dpkg-deb -f "$$deb" Package Version Architecture Depends; \
	file target/release/mappa

cli:
	$(CARGO) run -q -p mappa-cli -- --help

test:
	$(CARGO) test --workspace

fmt:
	$(CARGO) fmt --all

fmt-check:
	$(CARGO) fmt --all -- --check

clippy:
	$(CARGO) clippy --workspace --all-targets -- -D warnings

unicode-check:
	node scripts/check-unicode.mjs

smoke: ui-check
	cd ui && npm run smoke

bench:
	$(CARGO) run --release -p mappa-storage --example bench -- --tiles 10000 --with-packs

bench-large:
	$(CARGO) run --release -p mappa-storage --example bench -- --tiles 250000 --tile-size 48 --with-packs

bench-ui:
	cd ui && npm run build && npm run bench:fps

ui-install:
	cd ui && npm install

ui-dev:
	cd ui && npm run dev -- --host 127.0.0.1 --port 4173

ui-check:
	cd ui && npm run lint && npm run test && npm run build

check: fmt-check clippy test unicode-check ui-check

ci: check deb-check
