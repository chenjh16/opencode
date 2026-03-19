BUN ?= $(shell command -v bun 2>/dev/null || echo "npx bun")
PKG_DIR = $(CURDIR)/packages/opencode
OS_NAME := $(shell uname -s | tr A-Z a-z)
ARCH := $(shell uname -m)
ifeq ($(ARCH),x86_64)
  ARCH := x64
endif
ifeq ($(ARCH),aarch64)
  ARCH := arm64
endif
OPENCODE_BIN = $(PKG_DIR)/dist/opencode-$(OS_NAME)-$(ARCH)/bin/opencode

DEV_BRANCH = chenjh16/dev

BUILD_TARGETS ?= darwin-arm64,linux-x64,windows-x64
FORK_REPO ?= chenjh16/opencode
RELEASE_TAG ?= $(shell cd $(PKG_DIR) && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")

.PHONY: build run dev build-all build-select sync-dev push-dev release

build:
	@echo "=== Installing dependencies ==="
	@$(BUN) install
	@echo ""
	@echo "=== Building opencode for current platform ($(OS_NAME)-$(ARCH)) ==="
	@echo "    (use --single to build only current platform, --skip-install to skip cross-platform deps)"
	@cd $(PKG_DIR) && $(BUN) run script/build.ts --single --skip-install
	@echo ""
	@echo "=== Build complete ==="
	@ls -lh $(OPENCODE_BIN) 2>/dev/null || ls -lh $(PKG_DIR)/dist/opencode*/bin/opencode 2>/dev/null || echo "  (no binary found)"

run:
	@if [ -f "$(OPENCODE_BIN)" ]; then \
		echo "Running: $(OPENCODE_BIN)"; \
		exec $(OPENCODE_BIN); \
	else \
		echo "Binary not found at $(OPENCODE_BIN)"; \
		echo "Run 'make build' first, or use 'make dev' for development mode."; \
		exit 1; \
	fi

build-all:
	@echo "=== Installing dependencies (all platforms) ==="
	@$(BUN) install
	@echo ""
	@echo "=== Building opencode for ALL platforms ==="
	@cd $(PKG_DIR) && $(BUN) run script/build.ts
	@echo ""
	@echo "=== Build complete ==="
	@ls -lh $(PKG_DIR)/dist/opencode*/bin/opencode* 2>/dev/null || echo "  (no binaries found)"

dev:
	@cd $(PKG_DIR) && $(BUN) run --conditions=browser src/index.ts

build-select:
	@echo "=== Installing dependencies ==="
	@$(BUN) install
	@echo ""
	@echo "=== Building opencode for: $(BUILD_TARGETS) ==="
	@cd $(PKG_DIR) && $(BUN) run script/build.ts --targets=$(BUILD_TARGETS)
	@echo ""
	@echo "=== Build complete ==="
	@ls -lh $(PKG_DIR)/dist/opencode*/bin/opencode* 2>/dev/null || echo "  (no binaries found)"

sync-dev:
	@echo "=== Fetching upstream dev ==="
	@git fetch origin dev
	@echo "=== Pushing to fork dev ==="
	@git push fork origin/dev:refs/heads/dev --no-verify

push-dev:
	@echo "=== Fetching upstream dev ==="
	@git fetch origin dev
	@echo "=== Pushing to fork dev ==="
	@git push fork origin/dev:refs/heads/dev --no-verify
	@echo "=== Rebasing $(DEV_BRANCH) onto origin/dev ==="
	@git checkout $(DEV_BRANCH)
	@git rebase origin/dev
	@echo "=== Pushing $(DEV_BRANCH) to fork ==="
	@git push fork $(DEV_BRANCH) --force-with-lease --no-verify

release: build-all
	@[ -n "$$GH_TOKEN_RELEASE" ] || { echo "ERROR: GH_TOKEN_RELEASE not set. Create a token at https://github.com/settings/tokens (repo scope)."; exit 1; }
	@echo "=== Packaging binaries ==="
	@cd $(PKG_DIR)/dist && for d in opencode-*; do \
		[ -d "$$d" ] || continue; \
		case "$$d" in \
		*linux*) tar -czf "$$d.tar.gz" -C "$$d/bin" opencode && echo "  $$d.tar.gz" ;; \
		*) cd "$$d/bin" && zip "../../$$d.zip" opencode* && cd ../.. && echo "  $$d.zip" ;; \
		esac; \
	done
	@echo ""
	@echo "=== Creating release v$(RELEASE_TAG) on $(FORK_REPO) ==="
	@RELEASE_ID=$$(curl -sf -H "Authorization: token $$GH_TOKEN_RELEASE" \
		"https://api.github.com/repos/$(FORK_REPO)/releases/tags/v$(RELEASE_TAG)" \
		| python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null) && \
		echo "  Release exists (id=$$RELEASE_ID), uploading assets..." || { \
		RELEASE_ID=$$(curl -sf -X POST -H "Authorization: token $$GH_TOKEN_RELEASE" \
			-H "Content-Type: application/json" \
			-d '{"tag_name":"v$(RELEASE_TAG)","target_commitish":"$(DEV_BRANCH)","name":"v$(RELEASE_TAG)","body":"Built from $(DEV_BRANCH)"}' \
			"https://api.github.com/repos/$(FORK_REPO)/releases" \
			| python3 -c "import json,sys; print(json.load(sys.stdin)['id'])") && \
		echo "  Created release (id=$$RELEASE_ID)"; } && \
	for f in $(PKG_DIR)/dist/*.zip $(PKG_DIR)/dist/*.tar.gz; do \
		[ -f "$$f" ] || continue; \
		NAME=$$(basename "$$f"); \
		echo "  Uploading $$NAME..."; \
		OLD=$$(curl -sf -H "Authorization: token $$GH_TOKEN_RELEASE" \
			"https://api.github.com/repos/$(FORK_REPO)/releases/$$RELEASE_ID/assets" \
			| python3 -c "import json,sys; [print(a['id']) for a in json.load(sys.stdin) if a['name']=='$$NAME']" 2>/dev/null); \
		[ -z "$$OLD" ] || curl -sf -X DELETE -H "Authorization: token $$GH_TOKEN_RELEASE" \
			"https://api.github.com/repos/$(FORK_REPO)/releases/assets/$$OLD" >/dev/null; \
		case "$$NAME" in \
			*.zip) CT="application/zip" ;; \
			*.tar.gz) CT="application/gzip" ;; \
		esac; \
		curl -sf -X POST -H "Authorization: token $$GH_TOKEN_RELEASE" \
			-H "Content-Type: $$CT" \
			--data-binary @"$$f" \
			"https://uploads.github.com/repos/$(FORK_REPO)/releases/$$RELEASE_ID/assets?name=$$NAME" >/dev/null && \
		echo "    done" || echo "    FAILED"; \
	done

MOCK_PORT ?= 4199
MOCK_OUTPUT_DIR ?= $(CURDIR)/docs/extra/reqs
MOCK_PROMPT ?= hello
MOCK_CONFIG_FILE = $(CURDIR)/docs/extra/mock-opencode.json

.PHONY: getreq mock-server clean-reqs test-json-repair

getreq: clean-reqs
	@echo "=== Step 1: Writing mock config ==="
	@mkdir -p $(MOCK_OUTPUT_DIR)
	@printf '{\n\
  "$$schema": "https://opencode.ai/config.json",\n\
  "model": "mock/mock-model",\n\
  "provider": {\n\
    "mock": {\n\
      "name": "Mock LLM",\n\
      "api": "http://localhost:$(MOCK_PORT)/v1",\n\
      "npm": "@ai-sdk/openai-compatible",\n\
      "env": [],\n\
      "models": {\n\
        "mock-model": {\n\
          "name": "Mock Model",\n\
          "id": "mock-model",\n\
          "tool_call": true,\n\
          "temperature": true,\n\
          "reasoning": false,\n\
          "attachment": false,\n\
          "modalities": { "input": ["text"], "output": ["text"] },\n\
          "limit": { "context": 128000, "output": 16000 },\n\
          "cost": { "input": 0, "output": 0 }\n\
        }\n\
      },\n\
      "options": {\n\
        "apiKey": "mock-key",\n\
        "baseURL": "http://localhost:$(MOCK_PORT)/v1",\n\
        "includeUsage": true\n\
      }\n\
    }\n\
  }\n\
}\n' > $(MOCK_CONFIG_FILE)
	@echo "  Config: $(MOCK_CONFIG_FILE)"
	@echo ""
	@echo "=== Step 2: Starting Mock LLM Server on port $(MOCK_PORT) ==="
	@MOCK_PORT=$(MOCK_PORT) MOCK_OUTPUT_DIR=$(MOCK_OUTPUT_DIR) \
		$(BUN) run packages/opencode/script/mock-llm-server.ts &
	@sleep 4
	@echo ""
	@echo "=== Step 3: Sending request via opencode run ==="
	@rm -rf /tmp/opencode-mock && mkdir -p /tmp/opencode-mock
	@cd /tmp/opencode-mock && git init -q
	@cd /tmp/opencode-mock && \
		OPENCODE_CONFIG=$(MOCK_CONFIG_FILE) \
		OPENCODE_CLAUDE_TOOLS=1 \
		$(BUN) run --cwd $(CURDIR)/packages/opencode \
			--conditions=browser src/index.ts run \
			--dir /tmp/opencode-mock \
			"$(MOCK_PROMPT)" < /dev/null 2>&1 || true
	@echo ""
	@echo "=== Step 4: Stopping Mock LLM Server ==="
	@-pkill -f "mock-llm-server" 2>/dev/null || true
	@sleep 1
	@echo ""
	@echo "=== Done! Captured requests ==="
	@ls -la $(MOCK_OUTPUT_DIR)/*.json 2>/dev/null || echo "  (no requests captured)"

mock-server:
	@mkdir -p $(MOCK_OUTPUT_DIR)
	MOCK_PORT=$(MOCK_PORT) MOCK_OUTPUT_DIR=$(MOCK_OUTPUT_DIR) \
		$(BUN) run packages/opencode/script/mock-llm-server.ts

test-json-repair: clean-reqs
	@echo "=== JSON Repair E2E Test ==="
	@mkdir -p $(MOCK_OUTPUT_DIR)
	@echo "--- Starting mock server (broken-json mode) ---"
	@MOCK_PORT=$(MOCK_PORT) MOCK_OUTPUT_DIR=$(MOCK_OUTPUT_DIR) MOCK_MODE=broken-json \
		$(BUN) run packages/opencode/script/mock-llm-server.ts &
	@sleep 3
	@echo "--- Sending request ---"
	@rm -rf /tmp/opencode-mock && mkdir -p /tmp/opencode-mock
	@cd /tmp/opencode-mock && git init -q
	@cd /tmp/opencode-mock && \
		OPENCODE_CONFIG=$(MOCK_CONFIG_FILE) \
		OPENCODE_CLAUDE_TOOLS=1 \
		OPENCODE_LOG_TOOLCALL=1 \
		$(BUN) run --cwd $(CURDIR)/packages/opencode \
			--conditions=browser src/index.ts run \
			--print-logs \
			--dir /tmp/opencode-mock \
			"hello" < /dev/null 2>&1 | tee /tmp/opencode-mock-output.txt || true
	@echo ""
	@echo "--- Stopping mock server ---"
	@-pkill -f "mock-llm-server" 2>/dev/null || true
	@sleep 1
	@echo "--- Checking for JSON repair log ---"
	@if grep -q "repaired tool call JSON" /tmp/opencode-mock-output.txt 2>/dev/null; then \
		echo "PASS: JSON repair was triggered"; \
	else \
		echo "INFO: JSON repair log not found in output (check log file)"; \
	fi
	@echo "--- Toolcall logs ---"
	@LOGDIR="/tmp/opencode-mock/.opencode/logs/toolcall"; \
		echo "  dir: $$LOGDIR"; \
		if [ -d "$$LOGDIR" ]; then \
			ls -la "$$LOGDIR"/*.json 2>/dev/null || echo "  (no log files)"; \
			for f in "$$LOGDIR"/*.json; do \
				[ -f "$$f" ] && echo "" && echo "  === $$(basename $$f) ===" && cat "$$f"; \
			done; \
		else \
			echo "  (directory not created)"; \
		fi
	@echo "--- Captured requests ---"
	@ls -la $(MOCK_OUTPUT_DIR)/*.json 2>/dev/null || echo "  (no requests captured)"

clean-reqs:
	@rm -f $(MOCK_OUTPUT_DIR)/*.json 2>/dev/null || true
