# OpenShell automation notes

Running notes from instrumenting OpenShell v0.0.106 through `@nvidia/openshell-sdk` v0.0.106 on an ARM64 Linux Docker host. These are observations, not yet triaged upstream issues.

## Confirmed observations

### Sandbox names are limited to 19 characters

- **Symptom:** `CreateSandbox` returned `INVALID_ARGUMENT: name exceeds maximum length (22 > 19)`.
- **Context:** The SDK accepted the longer name locally and the gateway rejected it.
- **Workaround:** The lab uses `rlab-<12-character-run-id>` and truncates to 19 characters.
- **Possible improvement:** Export the server constraint in SDK types/helpers or preflight it in `SandboxClient.create` with the same error text.

### Docker sandbox creation requires gateway-minted JWT auth

- **Symptom:** A healthy plaintext Docker gateway rejected `CreateSandbox` with `FAILED_PRECONDITION: docker sandboxes require gateway JWT auth; configure [openshell.gateway.gateway_jwt]`.
- **Context:** The quick container-gateway path can reach `openshell status` without JWT configuration, but cannot create a Docker sandbox on this release.
- **Workaround:** Run `openshell-gateway generate-certs`, persist the generated `tls/jwt/{signing.pem,public.pem,kid}`, and configure `[openshell.gateway.gateway_jwt]`.
- **Possible improvement:** Make sandbox-JWT setup part of the plaintext container quick start and fail gateway startup early when the Docker driver is selected without it.

### Enabling sandbox JWTs changes anonymous user-call behavior

- **Symptom:** After JWT signing was enabled, SDK `CreateSandbox` changed from the missing-JWT precondition to `UNAUTHENTICATED: missing authorization header`.
- **Context:** Sandbox JWTs authenticate supervisors, but their presence also activates authentication dispatch for control-plane calls.
- **Workaround:** For this loopback-only, single-user lab, configure `[openshell.gateway.auth] allow_unauthenticated_users = true`. Sandbox callbacks still require minted JWTs.
- **Possible improvement:** Document this transition next to the Docker sandbox-JWT requirement so local operators do not interpret it as a client SDK token problem.

### Container state paths must be writable and path-identical where Docker consumes them

- **Symptom 1:** The gateway image runs as UID/GID `1000:1000`; a new named volume mounted at `/var/openshell` was root-owned and SQLite failed with `unable to open database file`.
- **Symptom 2:** With no `HOME`, default credential-key storage resolved under `/.local/...` and failed to create directories.
- **Symptom 3:** v0.0.106 pulled and cached its release-pinned supervisor under the gateway state directory even when `OPENSHELL_DOCKER_SUPERVISOR_BIN` was set. Docker later needs that cache at the exact same absolute host/container path.
- **Workaround:** Bind-mount a user-owned host state directory at the same absolute path inside the gateway, set `HOME` to it, and keep the DB/JWT/supervisor cache below it.
- **Possible improvement:** The container entrypoint could initialize a writable home/state directory, or the docs could avoid a fresh root-owned named volume and emphasize that the auto-extracted supervisor cache—not only a manually supplied supervisor binary—needs same-path mounting.

### Main-listener `/healthz` is not enabled by default

- **Symptom:** `curl http://127.0.0.1:8080/healthz` returned 404 even while the gRPC gateway was healthy.
- **Context:** Logs reported `Health server disabled`; `openshell status` and SDK `health()` both succeeded.
- **Workaround:** Use `openshell status` or SDK `health()` for this configuration, or configure the dedicated health listener.
- **Possible improvement:** Align the Docker Compose/container quick-start health command with the current health-listener default.

### A config file does not imply the container listener values from the callback endpoint

- **Symptom:** Adding only auth/JWT tables caused the gateway to use package defaults `127.0.0.1:17670`. Docker callback discovery then tried to bind host bridge address `172.21.0.1:17670` inside the gateway container and failed with `Cannot assign requested address`.
- **Context:** `OPENSHELL_GRPC_ENDPOINT=http://host.openshell.internal:8080` describes the supervisor callback endpoint; it does not set the primary bind address/port.
- **Workaround:** Explicitly set `OPENSHELL_BIND_ADDRESS=0.0.0.0` and `OPENSHELL_SERVER_PORT=8080` inside the container, while publishing it only as `127.0.0.1:8080:8080` on the host.
- **Possible improvement:** Add these explicit values to the container recipe and explain why an all-interface bind inside the container can still be loopback-only on the host.

### Loopback-only host publication does not provide container callback reachability

- **Symptom:** SDK calls through `127.0.0.1:8080` succeeded, but a sandbox stayed in `Provisioning` and repeatedly logged `Policy fetch failed ... failed to connect to OpenShell server`.
- **Context:** The sandbox correctly resolved `host.openshell.internal` to the `openshell-docker` bridge gateway (`172.21.0.1`). Publishing the gateway container only as `127.0.0.1:8080:8080` made that port unreachable from the bridge. Publishing the same port on `172.21.0.1` also did not provide reliable hairpin reachability from a container on that bridge.
- **Workaround:** Attach the gateway container to both Docker's default bridge and `openshell-docker`. Keep the host-loopback publication on the default interface for the user API. Set `[openshell.drivers.docker] host_gateway_ip` to the gateway container's `openshell-docker` address so sandbox aliases route directly to its authenticated callback interface.
- **Possible improvement:** Provide a supported two-interface container recipe, or make the gateway container/driver establish this topology automatically.

### Listener authorization depends on the local destination address

- **Symptom:** With the gateway container attached only to `openshell-docker` and `host_gateway_ip` set to that container address, an mTLS SDK `Health` call through the host's loopback publication returned `PERMISSION_DENIED: compute-driver callback listeners accept sandbox callback RPCs only`.
- **Context:** Host NAT landed on the same container IP selected as the callback listener. OpenShell correctly classified that destination as callback-only even though the client certificate was valid.
- **Workaround:** Give the container two interfaces. Host loopback NAT targets the default-bridge interface (full user API); supervisors connect to the `openshell-docker` interface (callback-only API).
- **Possible improvement:** Surface listener purpose/address in a concise diagnostic and document destination-address classification for containerized gateways.

### The auto-created OpenShell network does not permit a user-specified static IP

- **Symptom:** Docker rejected `--ip 172.21.0.254` with `user specified IP address is supported only when connecting to networks with user configured subnets`, even though network inspection showed `172.21.0.0/16`.
- **Workaround:** Start the gateway on the default bridge, connect the existing container to `openshell-docker`, inspect its assigned callback IP, store that value as `host_gateway_ip`, and restart the same container so its address is retained.
- **Possible improvement:** Create the OpenShell Docker network with explicitly configured IPAM suitable for a stable gateway-container address, or support a container DNS name as the sandbox host alias target.

### A stale plaintext gateway registration fails opaquely after enabling mTLS

- **Symptom:** `openshell status`, `whoami`, sandbox listing, provider listing, and the TUI failed with a broken-pipe/transport error even though SDK mTLS health checks succeeded.
- **Context:** The stored `reviewer-lab` registration still used `http://127.0.0.1:8080` with plaintext auth after the dedicated gateway was rebuilt for HTTPS and mTLS.
- **Workaround:** Remove the stale registration and re-add it with `openshell gateway add https://127.0.0.1:8080 --local --name reviewer-lab`. For a nonstandard package state directory, set `OPENSHELL_LOCAL_TLS_DIR` to the directory containing `ca.crt` and `client/{tls.crt,tls.key}` during registration.
- **Possible improvement:** Detect a plaintext client talking to a TLS listener and report a TLS/auth-mode mismatch instead of a generic broken pipe. Lab setup must validate CLI/TUI registration in addition to direct SDK connectivity.

### Generic Codex providers are revoked as unclassified under Providers v2

- **Symptom:** Sandbox startup logged `Rejected provider environment bindings; static provider credentials were revoked; provider environment contains an unclassified credential key`. The challenger then exited because `CODEX_AUTH_ACCESS_TOKEN` was absent.
- **Context:** The provider was created as type `generic` with the three documented Codex environment keys while `providers_v2_enabled=true`. The built-in `codex` profile declares and classifies those keys, but `generic` did not. The current CLI demo pattern in `examples/agent-driven-policy-management/demo.sh` also creates the Codex provider as `generic`, which may reproduce this on v0.0.106 when Providers v2 composition is enabled.
- **Workaround:** Create the provider with type `codex` so its credentials are classified by the built-in profile. The lab now does this.
- **Possible improvement:** Update the example to use the `codex` profile, or reject provider creation/attachment before sandbox startup when credential keys will be unclassified.

## Harness findings

### Generated sandbox name exceeded the gateway limit

The initial lab used `review-lab-<run-id>` and sliced to 63 characters. The SDK smoke caught the gateway's 19-character limit before the credentialed campaign. Fixed to `rlab-<run-id>` with a 19-character cap.

### Template placeholders survived environment validation

The copied `.env.example` supplied nonempty placeholder values for the GitHub owner and Codex auth path, so the harness's required-value check could not distinguish them from real configuration. The example now leaves the required owner blank and lets the auth file use the host default unless explicitly overridden.

### The sandbox image Codex CLI lagged the host CLI

- **Symptom:** The challenger exited with code 2 because `codex exec` did not recognize `--ignore-user-config` or `--ignore-rules`.
- **Context:** Station's host reviewer used Codex CLI 0.147.0, while `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` contained 0.117.0. The newer host supports both flags; the image version does not.
- **Workaround:** The challenger already creates a fresh home and temporary working directory, so the lab removed the unsupported flags and records `codex --version` in challenger stderr for every run.
- **Possible improvement:** Pin and report the sandbox image by digest, keep its agent CLIs current, or inject a known Codex build so challenger-version drift cannot silently change experimental behavior.

### The initial Station deployment was not a Git checkout

The first Station deployment copied the project directory without `.git`, so it could not receive the subsequent fix with `git pull`. The credential file and accumulated run evidence were preserved while deploying only reviewed changed files. Future scaled hosts should use a real clone and keep `.env` plus `runs/` as external or ignored state.

### Hidden chain-of-thought is not an available trace artifact

Codex `--json` provides observable event/tool traces and model-provided reasoning summaries, not private hidden chain-of-thought. The lab describes and stores only those observable artifacts, policy requests, decisions, explanations, and OpenShell events.

## Resolved smoke sequence

After applying the authenticated two-interface topology, the TypeScript SDK lifecycle completed with `created`, `ready`, and `deleted`. Earlier runs that emitted only `created` were waiting in `Provisioning` because the supervisor could not reach the callback listener; `waitReady` itself was behaving correctly.
