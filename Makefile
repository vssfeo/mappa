CARGO ?= $(HOME)/.cargo/bin/cargo
export PATH := $(dir $(CARGO)):$(PATH)
TAURI ?= ./ui/node_modules/.bin/tauri
DISPLAY_ENV ?= env -u WAYLAND_DISPLAY GDK_BACKEND=x11

.PHONY: run dev build deb deb-check release cli test fmt fmt-check clippy unicode-check smoke bench bench-large bench-ui bench-start startup startup-cold leak demo-pack ui-install ui-dev ui-check check ci

run dev:
	$(DISPLAY_ENV) $(TAURI) dev --no-watch

build:
	$(TAURI) build --no-bundle

deb:
	$(TAURI) build --bundles deb

release:
	./scripts/release.sh

deb-check: deb
	@deb="$$(find target/release/bundle/deb -name '*.deb' -print -quit)"; \
	test -n "$$deb"; \
	dpkg-deb -c "$$deb" >/tmp/mappa-deb.list; \
	grep -Eq '(^| )\.?/?usr/bin/mappa$$' /tmp/mappa-deb.list || { cat /tmp/mappa-deb.list; exit 1; }; \
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

bench-start:
	cd ui && npm run build && npm run bench:start

startup:
	./scripts/measure-startup.sh target/release/mappa 3

startup-cold:
	COLD=1 ./scripts/measure-startup.sh target/release/mappa 3

leak:
	./scripts/measure-leak.sh 10 30

demo-pack:
	python3 scripts/make_demo_pack.py assets/demo/demo.mbtiles

ui-install:
	cd ui && npm install

ui-dev:
	cd ui && npm run dev -- --host 127.0.0.1 --port 4173

ui-check:
	cd ui && npm run lint && npm run test && npm run build

check: fmt-check clippy test unicode-check ui-check

ci: check deb-check
