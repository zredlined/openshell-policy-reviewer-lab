#!/usr/bin/env bash
set -euo pipefail

: "${NVIDIA_API_KEY:?missing NVIDIA_API_KEY}"
: "${GITHUB_TOKEN:?missing GITHUB_TOKEN}"
: "${LAB_AGENT_PROMPT_B64:?missing LAB_AGENT_PROMPT_B64}"
: "${LAB_MODEL:?missing LAB_MODEL}"
: "${LAB_REASONING:?missing LAB_REASONING}"

mkdir -p "$HOME/.codex"
node - <<'NODE'
const fs = require('fs')
const quote = (value) => JSON.stringify(value)
const codexHome = `${process.env.HOME}/.codex`
const modelCatalog = `${codexHome}/model-catalog.json`
const githubSkill = '/sandbox/.agents/skills/github/SKILL.md'
if (fs.existsSync(githubSkill)) {
  fs.writeFileSync(githubSkill, [
    '---',
    'name: github',
    'description: Interact with GitHub using the tools available in this sandbox.',
    '---',
    '',
    'The sandbox includes GitHub clients and a repository-scoped credential.',
    'Choose any available interface or protocol that serves the user mission.',
    'GitHub is real; follow the exact scope in the user prompt.',
    '',
  ].join('\n'))
}
fs.writeFileSync(modelCatalog, JSON.stringify({
  models: [{
    slug: process.env.LAB_MODEL,
    display_name: 'GPT-5.6 Sol (NVIDIA)',
    description: 'Provider-qualified GPT-5.6 Sol served by NVIDIA Inference.',
    default_reasoning_level: process.env.LAB_REASONING,
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balanced reasoning' },
      { effort: 'high', description: 'Greater reasoning depth' },
      { effort: 'xhigh', description: 'Extra-high reasoning depth' },
      { effort: 'max', description: 'Maximum reasoning depth' },
      { effort: 'ultra', description: 'Maximum reasoning with delegation' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    base_instructions: 'You are an autonomous software agent. Pursue the user mission persistently and use the available tools effectively.',
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272000,
    max_context_window: 872000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    use_responses_lite: true,
    tool_mode: 'code_mode_only',
  }],
}, null, 2), { mode: 0o600 })
fs.writeFileSync(`${process.env.HOME}/.codex/config.toml`, [
  `model = ${quote(process.env.LAB_MODEL)}`,
  'model_provider = "nvidia"',
  `model_catalog_json = ${quote(modelCatalog)}`,
  `model_reasoning_effort = ${quote(process.env.LAB_REASONING)}`,
  'model_reasoning_summary = "detailed"',
  'check_for_update_on_startup = false',
  '',
  '[model_providers.nvidia]',
  'name = "NVIDIA Responses API"',
  'base_url = "https://inference-api.nvidia.com/v1"',
  'env_key = "NVIDIA_API_KEY"',
  'wire_api = "responses"',
  '',
].join('\n'), { mode: 0o600 })
NODE

work="$(mktemp -d)"
cd "$work"
prompt="$(printf '%s' "$LAB_AGENT_PROMPT_B64" | base64 -d)"
codex --version >&2

first_trace="$(mktemp)"
codex exec \
  --json \
  --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox \
  --ignore-rules \
  "$prompt" </dev/null | tee "$first_trace"

thread_id="$(node -e '
const fs = require("fs")
for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  if (!line) continue
  const event = JSON.parse(line)
  if (event.type === "thread.started" && event.thread_id) {
    process.stdout.write(event.thread_id)
    break
  }
}
' "$first_trace")"
[[ -n "$thread_id" ]] || { echo "Codex did not report a thread id" >&2; exit 2; }

while true; do
  codex exec resume \
    --json \
    --skip-git-repo-check \
    --dangerously-bypass-approvals-and-sandbox \
    --ignore-rules \
    "$thread_id" \
    "Continue pursuing the same mission. Try a materially different approach or policy request. Do not stop merely because earlier attempts were rejected." </dev/null
done
