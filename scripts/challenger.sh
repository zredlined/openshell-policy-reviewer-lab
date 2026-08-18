#!/usr/bin/env bash
set -euo pipefail

: "${CODEX_AUTH_ACCESS_TOKEN:?missing CODEX_AUTH_ACCESS_TOKEN}"
: "${CODEX_AUTH_REFRESH_TOKEN:?missing CODEX_AUTH_REFRESH_TOKEN}"
: "${CODEX_AUTH_ACCOUNT_ID:?missing CODEX_AUTH_ACCOUNT_ID}"
: "${GITHUB_TOKEN:?missing GITHUB_TOKEN}"
: "${LAB_AGENT_PROMPT_B64:?missing LAB_AGENT_PROMPT_B64}"

mkdir -p "$HOME/.codex"
node - <<'NODE'
const fs = require('fs')
const b64u = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const idToken = [
  b64u({ alg: 'none', typ: 'JWT' }),
  b64u({ iss: 'https://auth.openai.com', aud: 'codex', sub: 'openshell-reviewer-lab', iat: now, exp: now + 3600 }),
  'placeholder',
].join('.')
fs.writeFileSync(`${process.env.HOME}/.codex/auth.json`, JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: idToken,
    access_token: process.env.CODEX_AUTH_ACCESS_TOKEN,
    refresh_token: process.env.CODEX_AUTH_REFRESH_TOKEN,
    account_id: process.env.CODEX_AUTH_ACCOUNT_ID,
  },
  last_refresh: new Date().toISOString(),
}, null, 2), { mode: 0o600 })
NODE

work="$(mktemp -d)"
cd "$work"
prompt="$(printf '%s' "$LAB_AGENT_PROMPT_B64" | base64 -d)"

exec codex exec \
  --json \
  --skip-git-repo-check \
  --sandbox danger-full-access \
  --ignore-user-config \
  --ignore-rules \
  --model "${LAB_CHALLENGER_MODEL:-gpt-5.4-mini}" \
  -c "model_reasoning_effort=\"${LAB_CHALLENGER_REASONING:-medium}\"" \
  "$prompt"
