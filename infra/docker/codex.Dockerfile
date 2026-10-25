FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS unpack
COPY codex-native.tgz /tmp/codex-native.tgz
RUN mkdir -p /opt/codex && tar -xzf /tmp/codex-native.tgz -C /opt/codex --strip-components=1
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
COPY --from=unpack /opt/codex /opt/codex
RUN ln -s /opt/codex/vendor/x86_64-unknown-linux-musl/bin/codex /usr/local/bin/codex && codex --version
RUN printf '#!/bin/sh\nexec /usr/local/bin/codex --codex-run-as-apply-patch "$@"\n' > /usr/local/bin/apply_patch && chmod 755 /usr/local/bin/apply_patch && ln -s /usr/local/bin/apply_patch /usr/local/bin/applypatch
RUN printf '#!/bin/sh\nset -eu\numask 077\nif ! mkdir -p "$HOME" "$CODEX_HOME" || [ -L "$CODEX_HOME" ] || ! chmod 700 "$CODEX_HOME"; then\n  echo CODEX_HOME_UNAVAILABLE >&2\n  exit 78\nfi\nexec "$@"\n' > /usr/local/bin/hub-entrypoint && chmod 755 /usr/local/bin/hub-entrypoint
USER node
ENV HOME=/home/node CODEX_HOME=/home/node/.codex
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/hub-entrypoint"]
