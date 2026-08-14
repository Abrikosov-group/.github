import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(".github/workflows/review-all.yml", "utf8");
const caller = readFileSync("workflow-templates/review-all.yml", "utf8");
const organizationCaller = readFileSync(".github/workflows/review-all-trigger.yml", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const pullRequestTemplate = readFileSync(".github/pull_request_template.md", "utf8");

function extractJob(source, jobId) {
  const match = source.match(new RegExp(`\\n  ${jobId}:[\\s\\S]*?(?=\\n  [a-z][a-z0-9-]*:|$)`, "u"));
  assert.ok(match, `job ${jobId} не найден`);
  return match[0];
}

function extractRunScript(source, stepName) {
  const lines = source.split("\n");
  const nameIndex = lines.findIndex((line) => line === `      - name: ${stepName}`);
  assert.notEqual(nameIndex, -1, `step ${stepName} не найден`);

  const runIndex = lines.findIndex((line, index) => index > nameIndex && line === "        run: |");
  assert.notEqual(runIndex, -1, `run-блок step ${stepName} не найден`);

  const body = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.startsWith("          ")) {
      body.push(line.slice(10));
    } else if (line === "") {
      body.push("");
    } else {
      break;
    }
  }
  return body.join("\n");
}

function executeRunScript({
  source = workflow,
  stepName,
  env,
  event = {},
  ghMock,
  commandMocks = {},
}) {
  const root = mkdtempSync(join(tmpdir(), "organizational-review-test-"));
  try {
    const bin = join(root, "bin");
    const eventPath = join(root, "event.json");
    const outputPath = join(root, "output.txt");
    const summaryPath = join(root, "summary.md");
    const ghLogPath = join(root, "gh.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), ghMock, "utf8");
    chmodSync(join(bin, "gh"), 0o755);
    for (const [name, script] of Object.entries(commandMocks)) {
      writeFileSync(join(bin, name), script, "utf8");
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(eventPath, JSON.stringify(event), "utf8");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(summaryPath, "", "utf8");
    writeFileSync(ghLogPath, "", "utf8");

    const result = spawnSync("bash", ["-c", extractRunScript(source, stepName)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_WORKSPACE: root,
        RUNNER_TEMP: root,
        MOCK_GH_LOG: ghLogPath,
        ...env,
      },
    });

    return {
      ...result,
      outputs: readFileSync(outputPath, "utf8"),
      summary: readFileSync(summaryPath, "utf8"),
      ghLog: readFileSync(ghLogPath, "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const contextGhMock = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"/issues/comments/"*) printf '%s\n' "\${MOCK_COMMENT_JSON}" ;;
  *"/collaborators/"*"/permission"*) printf '%s\n' "\${MOCK_PERMISSION:-write}" ;;
  *"/pulls/"*) printf '%s\n' "\${MOCK_PR_JSON}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 64 ;;
esac
`;

const acknowledgementGhMock = `#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "\${MOCK_GH_LOG}"
args="$*"
if [[ "\${args}" == *"--method DELETE"* ]]; then
  if [[ -n "\${MOCK_DELETE_FAILURE_ID:-}" &&
        "\${args}" == *"/reactions/\${MOCK_DELETE_FAILURE_ID}"* ]]; then
    exit 1
  fi
elif [[ "\${args}" == *"--method POST"* && "\${args}" == *"/reactions"* ]]; then
  if [[ -n "\${MOCK_POST_FAILURE_CONTENT:-}" &&
        "\${args}" == *"content=\${MOCK_POST_FAILURE_CONTENT}"* ]]; then
    exit 1
  fi
  printf '{}\n'
elif [[ "\${args}" == *"/reactions"* ]]; then
  printf '%s\n' "\${MOCK_REACTIONS_JSON:-[[]]}"
elif [[ "\${args}" == *"/issues/comments/"* ]]; then
  printf '%s\n' "\${MOCK_COMMENT_JSON}"
elif [[ "\${args}" == *"/collaborators/"*"/permission"* ]]; then
  printf '%s\n' "\${MOCK_PERMISSION:-write}"
elif [[ "\${args}" == *"/pulls/"* ]]; then
  printf '%s\n' "\${MOCK_PR_JSON}"
else
  echo "unexpected gh call: \${args}" >&2
  exit 64
fi
`;

const statusGhMock = `#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "\${MOCK_GH_LOG}"
args="$*"
if [[ "\${args}" == *"--method DELETE"* ]]; then
  if [[ -n "\${MOCK_DELETE_FAILURE_ID:-}" &&
        "\${args}" == *"/reactions/\${MOCK_DELETE_FAILURE_ID}"* ]]; then
    exit 1
  fi
elif [[ "\${args}" == *"--method POST"* && "\${args}" == *"/reactions"* ]]; then
  printf '{}\n'
elif [[ "\${args}" == *"/reactions"* ]]; then
  printf '%s\n' "\${MOCK_REACTIONS_JSON:-[[]]}"
elif [[ "\${args}" == *"/issues/17/comments?"* ]]; then
  printf '%s\n' "\${MOCK_STATUS_COMMENTS_JSON:-[[]]}"
elif [[ "\${args}" == *"--method POST"* && "\${args}" == *"/issues/17/comments"* ]]; then
  printf '{"id":99}\n'
elif [[ "\${args}" == *"--method PATCH"* && "\${args}" == *"/issues/comments/"* ]]; then
  printf '{}\n'
elif [[ "\${args}" == *"--method POST"* && "\${args}" == *"/statuses/"* ]]; then
  printf '{}\n'
else
  echo "unexpected gh call: \${args}" >&2
  exit 64
fi
`;

const markerGhMock = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "\${MOCK_GH_LOG}"
if [[ "$*" == "auth setup-git" ]]; then
  exit 0
elif [[ "$*" == *"/reviews?"* ]]; then
  printf '%s\n' "\${MOCK_REVIEWS_JSON}"
elif [[ "$*" == *"/pulls/17"* ]]; then
  printf '%s\n' "\${MOCK_PR_JSON}"
else
  echo "unexpected gh call: $*" >&2
  exit 64
fi
`;

const finishStatusGhMock = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "\${MOCK_GH_LOG}"
if [[ "$*" == *"/pulls/17"* ]]; then
  printf '%s\n' "\${HEAD_SHA}"
elif [[ "$*" == *"--method PATCH"* && "$*" == *"/issues/comments/99"* ]]; then
  printf '{}\n'
elif [[ "$*" == *"--method POST"* && "$*" == *"/statuses/"* ]]; then
  printf '{}\n'
else
  echo "unexpected gh call: $*" >&2
  exit 64
fi
`;

const gitHeadMock = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "rev-parse HEAD") printf '%s\n' "\${BASE_SHA}" ;;
  "rev-parse FETCH_HEAD") printf '%s\n' "\${HEAD_SHA}" ;;
  fetch*) ;;
  "merge-base --is-ancestor "*) ;;
  "merge-base "*) printf '%s\n' "\${BASE_SHA}" ;;
  diff*) printf '%s\n' 'diff --git a/file.txt b/file.txt' ;;
  *) echo "unexpected git call: $*" >&2; exit 64 ;;
esac
`;

function contextEnv(overrides = {}) {
  return {
    CALLER_REPOSITORY: "Abrikosov-group/project",
    REPOSITORY: "Abrikosov-group/project",
    PR_NUMBER: "17",
    COMMENT_ID: "0",
    COMMAND: "/review-all",
    AUTHOR_ASSOCIATION: "",
    EXPECTED_HEAD_SHA: "",
    TRIGGER: "automatic",
    TRIGGER_ACTOR: "alice",
    EVENT_NAME: "pull_request_target",
    EVENT_ACTION: "synchronize",
    AUTOMATIC_BASE_REFS: "main",
    MANUAL_BASE_REFS: "*",
    MOCK_PERMISSION: "write",
    ...overrides,
  };
}

function prFixture({
  baseRef = "main",
  baseSha = "a".repeat(40),
  headSha = "b".repeat(40),
  headRepository = "Abrikosov-group/project",
  state = "open",
  draft = false,
} = {}) {
  return JSON.stringify({
    state,
    draft,
    base: { ref: baseRef, sha: baseSha },
    head: { sha: headSha, repo: { full_name: headRepository } },
  });
}

function automaticEvent(headSha, baseRef = "main", changes) {
  const event = {
    pull_request: {
      number: 17,
      base: { ref: baseRef },
      head: { sha: headSha, repo: { full_name: "Abrikosov-group/project" } },
      draft: false,
    },
  };
  if (changes !== undefined) {
    event.changes = changes;
  }
  return event;
}

function reaction(id, content, login = "github-actions[bot]") {
  return { id, content, user: { login } };
}

function slurpedReactions(...reactions) {
  return JSON.stringify([reactions]);
}

function commandCommentFixture() {
  return JSON.stringify({
    issue_url: "https://api.github.com/repos/Abrikosov-group/project/issues/17",
    body: "/review-all",
    user: { login: "alice" },
    author_association: "MEMBER",
  });
}

function acknowledgementEnv(overrides = {}) {
  return {
    REPOSITORY: "Abrikosov-group/project",
    PR_NUMBER: "17",
    COMMENT_ID: "91",
    TRIGGER_ACTOR: "alice",
    RUN_ATTEMPT: "1",
    MOCK_COMMENT_JSON: commandCommentFixture(),
    MOCK_PR_JSON: prFixture(),
    MOCK_REACTIONS_JSON: slurpedReactions(),
    ...overrides,
  };
}

function statusEnv(overrides = {}) {
  return {
    REPOSITORY: "Abrikosov-group/project",
    PR_NUMBER: "17",
    COMMAND_COMMENT_ID: "91",
    COMMENT_ID: "91",
    TRIGGER: "manual",
    MODE: "all",
    HEAD_SHA: "b".repeat(40),
    RUN_URL: "https://github.com/Abrikosov-group/project/actions/runs/1",
    REACTION_GH_TOKEN: "test-reaction-token",
    REVIEW_PUBLISHER_LOGIN: "github-actions[bot]",
    REUSE_EXISTING_REVIEWS: "true",
    REVIEW_GATE_CONTEXT: "",
    ...overrides,
  };
}

test("организационный workflow запускает только Codex и Claude", () => {
  assert.match(workflow, /--model gpt-5\.3-codex-spark/u);
  assert.match(workflow, /claude-sonnet-5/u);
  assert.doesNotMatch(workflow, /@codex review/u);
  assert.doesNotMatch(workflow, /\/gemini\s+review/iu);
  assert.doesNotMatch(workflow, /gemini_url|dispatch-gemini/iu);
  assert.match(workflow, /\/review-all/u);
  assert.match(workflow, /\/review-claude/u);
});

test("Codex использует подписочный Spark xhigh на настраиваемом защищённом Runner", () => {
  const codexJob = extractJob(workflow, "analyze-codex");
  assert.match(codexJob, /runs-on:\n\s+group: \$\{\{ inputs\.review_runner_group \}\}\n\s+labels: \$\{\{ inputs\.codex_runner_label \}\}/u);
  assert.match(workflow, /EXPECTED_RUNNER_NAME: \$\{\{ inputs\.expected_codex_runner_name \}\}/u);
  assert.match(workflow, /codex login status/u);
  assert.match(workflow, /--model gpt-5\.3-codex-spark/u);
  assert.match(workflow, /model_reasoning_effort="xhigh"/u);
  assert.match(workflow, /web_search="disabled"/u);
  assert.match(workflow, /REVIEW_MODEL: gpt-5\.3-codex-spark/u);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/u);
  assert.match(
    workflow,
    /REVIEW_DISPATCH_TOKEN:\n\s+description: Устаревший совместимый секрет; новое ревью его не использует\n\s+required: false/u,
  );
  assert.doesNotMatch(workflow, /secrets\.REVIEW_DISPATCH_TOKEN/u);
});

test("все jobs закреплены одновременно за runner group, label и точным именем", () => {
  const serviceJobs = [
    "context",
    "start-status",
    "prepare-codex",
    "publish-codex",
    "publish-claude",
    "finish-status",
  ];
  const modelJobs = [
    ["analyze-codex", "codex_runner_label", "expected_codex_runner_name", "Codex"],
    ["analyze-claude", "claude_runner_label", "expected_claude_runner_name", "Claude"],
  ];

  for (const input of [
    "review_runner_group",
    "orchestration_runner_label",
    "codex_runner_label",
    "claude_runner_label",
    "expected_orchestration_runner_name",
    "expected_codex_runner_name",
    "expected_claude_runner_name",
  ]) {
    assert.match(
      workflow,
      new RegExp(`${input}:\\n\\s+description: [^\\n]+\\n\\s+required: true\\n\\s+type: string`, "u"),
    );
  }

  for (const jobId of serviceJobs) {
    const job = extractJob(workflow, jobId);
    assert.match(job, /runs-on:\n\s+group: \$\{\{ inputs\.review_runner_group \}\}\n\s+labels: \$\{\{ inputs\.orchestration_runner_label \}\}/u);
    assert.match(job, /steps:\n\s+- name: Проверить доверенный Runner оркестрации/u);
    assert.match(job, /EXPECTED_RUNNER_NAME: \$\{\{ inputs\.expected_orchestration_runner_name \}\}/u);
  }

  for (const [jobId, labelInput, nameInput, displayName] of modelJobs) {
    const job = extractJob(workflow, jobId);
    assert.match(
      job,
      new RegExp(`runs-on:\\n\\s+group: \\$\\{\\{ inputs\\.review_runner_group \\}\\}\\n\\s+labels: \\$\\{\\{ inputs\\.${labelInput} \\}\\}`, "u"),
    );
    assert.match(job, new RegExp(`steps:\\n\\s+- name: Проверить доверенный Runner ${displayName}`, "u"));
    assert.match(job, new RegExp(`EXPECTED_RUNNER_NAME: \\$\\{\\{ inputs\\.${nameInput} \\}\\}`, "u"));
  }

  assert.doesNotMatch(workflow, /runs-on: \$\{\{ inputs\.[a-z_]+_runner_label \}\}/u);
  assert.doesNotMatch(workflow, /runs-on: (?:ubuntu|windows|macos)-/u);
});

test("точный diff строится от доказанного merge base", () => {
  assert.match(workflow, /git fetch --no-tags --no-recurse-submodules/u);
  assert.match(workflow, /origin "refs\/pull\/\$\{PR_NUMBER\}\/head"/u);
  assert.match(workflow, /merge_base="\$\(git merge-base "\$\{BASE_SHA\}" "\$\{HEAD_SHA\}"\)"/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.match(workflow, /git diff --binary --find-renames --full-index/u);
  assert.match(workflow, /"\$\{merge_base\}" "\$\{HEAD_SHA\}"/u);
  assert.doesNotMatch(workflow, /application\/vnd\.github\.diff/u);
});

test("исполняемый организационный код закреплён полными SHA", () => {
  assert.doesNotMatch(workflow, /\n\s+ref: main\s*$/mu);
  assert.match(workflow, /repository: \$\{\{ job\.workflow_repository \}\}/u);
  assert.match(workflow, /ref: \$\{\{ job\.workflow_sha \}\}/u);
  assert.match(
    caller,
    /Abrikosov-group\/\.github\/\.github\/workflows\/review-all\.yml@[0-9a-f]{40}/u,
  );
  assert.match(
    organizationCaller,
    /Abrikosov-group\/\.github\/\.github\/workflows\/review-all\.yml@[0-9a-f]{40}/u,
  );
  assert.doesNotMatch(caller, /review-all\.yml@main/u);
  assert.doesNotMatch(organizationCaller, /review-all\.yml@main/u);
});

test("Codex не получает shell, плагины, GitHub-токен или checkout PR", () => {
  const codexJob = workflow.match(/\n  analyze-codex:[\s\S]*?(?=\n  publish-codex:)/u)?.[0];

  assert.ok(codexJob);
  assert.match(codexJob, /permissions: \{\}/u);
  assert.match(codexJob, /env -i/u);
  assert.match(codexJob, /--ignore-user-config/u);
  assert.match(codexJob, /--ignore-rules/u);
  assert.match(codexJob, /--disable shell_tool/u);
  assert.match(codexJob, /--disable plugins/u);
  assert.doesNotMatch(codexJob, /actions\/checkout/u);
  assert.doesNotMatch(codexJob, /GH_TOKEN|GITHUB_TOKEN/u);
});

test("Codex публикуется только после схемы и доверенного издателя", () => {
  assert.match(workflow, /--output-schema "\$\{schema_path\}"/u);
  assert.match(workflow, /--output-last-message "\$\{result_path\}"/u);
  assert.match(workflow, /REVIEW_JSON_FILE:/u);
  assert.match(workflow, /codex-review:\$\{BASE_SHA\}:\$\{HEAD_SHA\}:gpt-5\.3-codex-spark/u);
  assert.match(workflow, /node _review_infra\/\.github\/review\/publish-claude-review\.mjs/u);
});

test("Claude использует подписочный OAuth и не может перейти на API-ключ", () => {
  assert.match(workflow, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/u);
  assert.match(workflow, /ANTHROPIC_API_KEY: ""/u);
  assert.match(workflow, /ANTHROPIC_AUTH_TOKEN: ""/u);
  assert.match(workflow, /--safe-mode/u);
  assert.doesNotMatch(workflow, /--bare/u);
  assert.doesNotMatch(workflow, /ANTHROPIC_API_KEY:\s*\$\{\{/u);
  assert.doesNotMatch(workflow, /ANTHROPIC_AUTH_TOKEN:\s*\$\{\{/u);
});

test("обычное ревью Claude закреплено на Sonnet 5 с xhigh", () => {
  assert.match(workflow, /--model claude-sonnet-5/u);
  assert.match(workflow, /--effort xhigh/u);
  assert.match(workflow, /REVIEW_MODEL: claude-sonnet-5/u);
  assert.doesNotMatch(workflow, /--max-turns/u);
});

test("Claude не получает инструменты записи, shell или сеть", () => {
  assert.match(workflow, /--tools "Read"/u);
  assert.match(workflow, /--disallowedTools "[^"]*Bash[^"]*WebFetch[^"]*WebSearch"/u);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+pull-requests: read/u);
  assert.match(workflow, /Не включай HTML-теги, HTML-комментарии или служебные маркеры/u);
});

test("Claude запускается из точного доверенного Base checkout", () => {
  const baseCheckout = workflow.match(
    /- name: Получить точный Base в защищённый корень[\s\S]*?(?=\n      - name:)/u,
  )?.[0];

  assert.ok(baseCheckout);
  assert.match(baseCheckout, /repository: \$\{\{ inputs\.repository \}\}/u);
  assert.match(baseCheckout, /ref: \$\{\{ needs\.context\.outputs\.base_sha \}\}/u);
  assert.match(baseCheckout, /persist-credentials: false/u);
  assert.doesNotMatch(baseCheckout, /\n\s+path:/u);
  assert.match(workflow, /"\$\(git rev-parse HEAD\)" != "\$\{BASE_SHA\}"/u);
  assert.ok(
    workflow.indexOf("Получить точный Base в защищённый корень") <
      workflow.indexOf("Выполнить изолированное review-only ревью"),
  );
});

test("ручной источник проверяется без хрупких сравнений URL, регистра и снимков роли", () => {
  assert.match(workflow, /TRIGGER_ACTOR: \$\{\{ github\.actor \}\}/u);
  assert.match(workflow, /capture\("\/issues\/\(\?<number>\[1-9\]\[0-9\]\*\)\$"\)/u);
  assert.match(
    workflow,
    /"\$\{comment_author_normalized\}" != "\$\{trigger_actor_normalized\}"/u,
  );
  assert.match(workflow, /tr '\[:upper:\]' '\[:lower:\]'/u);
  assert.match(workflow, /case "\$\{comment_author_association\}" in/u);
  assert.doesNotMatch(workflow, /expected_issue_url/u);
  assert.doesNotMatch(
    workflow,
    /"\$\{comment_author_association\}" != "\$\{AUTHOR_ASSOCIATION\}"/u,
  );
});

test("[1] актуальный и устаревший SHA события выбирают текущий Head", () => {
  const eventHeadSha = "b".repeat(40);
  for (const { currentHeadSha, noticeExpected } of [
    { currentHeadSha: eventHeadSha, noticeExpected: false },
    { currentHeadSha: "c".repeat(40), noticeExpected: true },
  ]) {
    const result = executeRunScript({
      stepName: "Проверить источник запуска",
      ghMock: contextGhMock,
      event: automaticEvent(eventHeadSha),
      env: contextEnv({
        EXPECTED_HEAD_SHA: eventHeadSha,
        MOCK_PR_JSON: prFixture({ headSha: currentHeadSha }),
      }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.outputs, new RegExp(`^head_sha=${currentHeadSha}$`, "mu"));
    if (noticeExpected) {
      assert.match(
        result.stdout,
        new RegExp(`::notice::.*${eventHeadSha}.*${currentHeadSha}`, "u"),
      );
    } else {
      assert.doesNotMatch(result.stdout, /::notice::/u);
    }
  }
});

test("[2] ручной запуск вне main и из форка разрешён в обоих слоях", () => {
  const headSha = "d".repeat(40);
  const comment = JSON.stringify({
    issue_url: "https://api.github.com/repos/Abrikosov-group/project/issues/17",
    body: "/review-all",
    user: { login: "alice" },
    author_association: "MEMBER",
  });
  const result = executeRunScript({
    stepName: "Проверить источник запуска",
    ghMock: contextGhMock,
    env: contextEnv({
      COMMENT_ID: "91",
      AUTHOR_ASSOCIATION: "MEMBER",
      TRIGGER: "manual",
      EVENT_NAME: "issue_comment",
      EVENT_ACTION: "created",
      MOCK_COMMENT_JSON: comment,
      MOCK_PR_JSON: prFixture({
        baseRef: "develop",
        headSha,
        headRepository: "contributor/project",
      }),
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.outputs, /^base_ref=develop$/mu);
  assert.match(result.outputs, new RegExp(`^head_sha=${headSha}$`, "mu"));

  const acknowledgement = executeRunScript({
    source: caller,
    stepName: "Проверить и подтвердить ручную команду",
    ghMock: acknowledgementGhMock,
    env: acknowledgementEnv({
      MOCK_PR_JSON: prFixture({
        baseRef: "develop",
        headSha,
        headRepository: "contributor/project",
      }),
    }),
  });
  assert.equal(acknowledgement.status, 0, acknowledgement.stderr);
  assert.match(acknowledgement.outputs, /^accepted=true$/mu);
  assert.match(acknowledgement.ghLog, /--raw-field content=eyes/u);

  for (const source of [caller, organizationCaller]) {
    const acknowledgeJob = extractJob(source, "acknowledge-manual");
    const manualJob = extractJob(source, "manual-review");
    assert.doesNotMatch(acknowledgeJob, /base\.ref|head\.repo/u);
    assert.doesNotMatch(manualJob, /base\.ref|head\.repo|draft/u);
  }
});

test("ручной запуск допускает регистр логина и разные доверенные снимки роли", () => {
  const headSha = "d".repeat(40);
  const comment = JSON.stringify({
    issue_url: "https://api.github.com/repos/Abrikosov-group/project/issues/17",
    body: "/review-all",
    user: { login: "Alice" },
    author_association: "COLLABORATOR",
  });
  const result = executeRunScript({
    stepName: "Проверить источник запуска",
    ghMock: contextGhMock,
    env: contextEnv({
      COMMENT_ID: "91",
      AUTHOR_ASSOCIATION: "MEMBER",
      TRIGGER: "manual",
      EVENT_NAME: "issue_comment",
      EVENT_ACTION: "created",
      TRIGGER_ACTOR: "alice",
      MOCK_COMMENT_JSON: comment,
      MOCK_PR_JSON: prFixture({ headSha }),
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.outputs, new RegExp(`^head_sha=${headSha}$`, "mu"));
});

test("повторный API-запрос не доверяет фактической роли NONE", () => {
  const comment = JSON.stringify({
    issue_url: "https://api.github.com/repos/Abrikosov-group/project/issues/17",
    body: "/review-all",
    user: { login: "alice" },
    author_association: "NONE",
  });
  const result = executeRunScript({
    stepName: "Проверить источник запуска",
    ghMock: contextGhMock,
    env: contextEnv({
      COMMENT_ID: "91",
      AUTHOR_ASSOCIATION: "MEMBER",
      TRIGGER: "manual",
      EVENT_NAME: "issue_comment",
      EVENT_ACTION: "created",
      MOCK_COMMENT_JSON: comment,
      MOCK_PR_JSON: prFixture(),
    }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Фактический автор комментария не имеет права/u);
});

test("[3] автоматический запуск вне разрешённых веток и из форка запрещён", () => {
  const headSha = "e".repeat(40);
  for (const source of [caller, organizationCaller]) {
    const automaticJob = extractJob(source, "automatic-review");
    assert.match(automaticJob, /github\.event\.pull_request\.base\.ref == 'main'/u);
    assert.match(
      automaticJob,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u,
    );
  }

  for (const { prJson, expectedError } of [
    {
      prJson: prFixture({ baseRef: "develop", headSha }),
      expectedError: /Base-ветка develop не разрешена/u,
    },
    {
      prJson: prFixture({ headSha, headRepository: "contributor/project" }),
      expectedError: /только для ветки этого репозитория/u,
    },
  ]) {
    const result = executeRunScript({
      stepName: "Проверить источник запуска",
      ghMock: contextGhMock,
      event: automaticEvent(headSha),
      env: contextEnv({ EXPECTED_HEAD_SHA: headSha, MOCK_PR_JSON: prJson }),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, expectedError);
  }

  const stagingResult = executeRunScript({
    stepName: "Проверить источник запуска",
    ghMock: contextGhMock,
    event: automaticEvent(headSha, "staging"),
    env: contextEnv({
      EXPECTED_HEAD_SHA: headSha,
      AUTOMATIC_BASE_REFS: "main,staging",
      MOCK_PR_JSON: prFixture({ baseRef: "staging", headSha }),
    }),
  });
  assert.equal(stagingResult.status, 0, stagingResult.stderr);
  assert.match(stagingResult.outputs, /^base_ref=staging$/mu);
});

test("смена base-ветки повторно запускает ревью, а прочее edited-событие отклоняется", () => {
  const headSha = "f".repeat(40);
  const changedBase = executeRunScript({
    stepName: "Проверить источник запуска",
    ghMock: contextGhMock,
    event: automaticEvent(headSha, "staging", {
      base: { ref: { from: "release@2026/ветка+gate" } },
    }),
    env: contextEnv({
      EVENT_ACTION: "edited",
      EXPECTED_HEAD_SHA: headSha,
      AUTOMATIC_BASE_REFS: "main,staging",
      MOCK_PR_JSON: prFixture({ baseRef: "staging", headSha }),
    }),
  });
  assert.equal(changedBase.status, 0, changedBase.stderr);
  assert.match(changedBase.outputs, /^base_ref=staging$/mu);

  const titleOnlyEdit = executeRunScript({
    stepName: "Проверить источник запуска",
    ghMock: contextGhMock,
    event: automaticEvent(headSha, "staging", {
      title: { from: "Старый заголовок" },
    }),
    env: contextEnv({
      EVENT_ACTION: "edited",
      EXPECTED_HEAD_SHA: headSha,
      AUTOMATIC_BASE_REFS: "main,staging",
      MOCK_PR_JSON: prFixture({ baseRef: "staging", headSha }),
    }),
  });
  assert.notEqual(titleOnlyEdit.status, 0);
});

test("[7–10] центральная очередь едина для manual и automatic одного PR", () => {
  const concurrency = workflow.match(/\nconcurrency:\n[\s\S]*?\n\njobs:/u)?.[0];
  assert.ok(concurrency);
  assert.equal(
    concurrency.trim().replace(/\n\njobs:$/u, ""),
    [
      "concurrency:",
      "  group: organizational-review-engine-${{ inputs.repository }}-${{ inputs.pr_number }}",
      "  cancel-in-progress: false",
      "  queue: max",
    ].join("\n"),
  );
  assert.doesNotMatch(concurrency, /inputs\.trigger/u);
  assert.doesNotMatch(concurrency, /inputs\.comment_id|head_sha/u);
});

test("новый automatic-запуск не отменяет ручной review-all", () => {
  const concurrency = workflow.match(/\nconcurrency:\n[\s\S]*?\n\njobs:/u)?.[0];
  assert.ok(concurrency);
  assert.match(concurrency, /cancel-in-progress: false/u);
  assert.doesNotMatch(concurrency, /cancel-in-progress:.*automatic/u);
});

test("GitHub App сам определяет login доверенного издателя", () => {
  const result = executeRunScript({
    stepName: "Определить доверенного издателя",
    ghMock: contextGhMock,
    env: {
      APP_CLIENT_ID: "Iv23example",
      APP_SLUG: "abrikosov-review-gate-publisher",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.outputs, /^login=abrikosov-review-gate-publisher\[bot\]$/mu);
  assert.match(workflow, /client-id: \$\{\{ inputs\.review_gate_app_client_id \}\}/u);

  const fallback = executeRunScript({
    stepName: "Определить доверенного издателя",
    ghMock: contextGhMock,
    env: {
      APP_CLIENT_ID: "",
      APP_SLUG: "",
    },
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.outputs, /^login=github-actions\[bot\]$/mu);
  assert.doesNotMatch(workflow, /review_publisher_login|FALLBACK_LOGIN/u);
});

test("разрешённые base-ветки параметризованы, а same-repo обязателен для автозапуска", () => {
  assert.match(
    workflow,
    /base_ref_allowed "\$\{allowed_base_refs\}" "\$\{base_ref\}"/u,
  );
  assert.match(
    workflow,
    /if \[\[ ! "\$\{base_sha\}" =~ \^\[0-9a-f\]\{40\}\$ \|\| ! "\$\{head_sha\}" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u,
  );
  assert.doesNotMatch(
    workflow,
    /"\$\{base_ref\}" != "main"/u,
  );
  assert.match(workflow, /"\$\{head_repository\}" != "\$\{REPOSITORY\}"/u);
});

test("автоматический источник закрепляет точный Head готового PR", () => {
  assert.match(workflow, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.match(workflow, /opened\|ready_for_review\|synchronize\|reopened\|edited/u);
  assert.match(workflow, /\.changes\.base\.ref\.from/u);
  assert.match(workflow, /event_head_repository/u);
  assert.match(workflow, /event_draft/u);
  assert.match(workflow, /head_sha\}" != "\$\{EXPECTED_HEAD_SHA\}/u);
  assert.match(workflow, /выбран текущий Head \$\{head_sha\}/u);
  assert.doesNotMatch(workflow, /Head PR изменился после автоматического события/u);
});

test("bot-login с фактическим write-доступом проходит проверку прав", () => {
  const headSha = "e".repeat(40);
  const result = executeRunScript({
    stepName: "Проверить источник запуска",
    ghMock: contextGhMock,
    event: automaticEvent(headSha),
    env: contextEnv({
      EXPECTED_HEAD_SHA: headSha,
      TRIGGER_ACTOR: "dependabot[bot]",
      MOCK_PERMISSION: "write",
      MOCK_PR_JSON: prFixture({ headSha }),
    }),
  });
  assert.equal(result.status, 0, result.stderr);
});

test("дорогие этапы ревью ограничены по времени", () => {
  const prepareCodex = workflow.match(/\n  prepare-codex:[\s\S]*?(?=\n  analyze-codex:)/u)?.[0];
  const analyzeCodex = workflow.match(/\n  analyze-codex:[\s\S]*?(?=\n  publish-codex:)/u)?.[0];
  const analyzeClaude = workflow.match(/\n  analyze-claude:[\s\S]*?(?=\n  publish-claude:)/u)?.[0];

  assert.ok(prepareCodex);
  assert.ok(analyzeCodex);
  assert.ok(analyzeClaude);
  assert.match(prepareCodex, /timeout-minutes: 10/u);
  assert.match(analyzeCodex, /timeout-minutes: 25/u);
  assert.match(analyzeClaude, /timeout-minutes: 25/u);
});

test("шаблон запускает ревью автоматически и оставляет ручной повтор", () => {
  assert.match(caller, /issue_comment:/u);
  assert.match(caller, /pull_request_target:/u);
  assert.match(caller, /opened/u);
  assert.match(caller, /ready_for_review/u);
  assert.match(caller, /synchronize/u);
  assert.match(caller, /reopened/u);
  assert.match(caller, /github\.event\.comment\.body == '\/review-all'/u);
  assert.match(caller, /trigger: manual/u);
  assert.match(caller, /trigger: automatic/u);
  assert.match(caller, /expected_head_sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(
    caller,
    /group: organizational-review-caller-auto-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ github\.event\.pull_request\.head\.sha \}\}/u,
  );
  assert.match(caller, /cancel-in-progress: true/u);
  assert.doesNotMatch(caller, /\/review-claude/u);
  assert.match(
    caller,
    /Abrikosov-group\/\.github\/\.github\/workflows\/review-all\.yml@[0-9a-f]{40}/u,
  );
  assert.doesNotMatch(caller, /REVIEW_DISPATCH_TOKEN/u);
  assert.match(caller, /CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/u);
});

test("центральный репозиторий сам слушает команду и новые снимки PR", () => {
  assert.match(organizationCaller, /issue_comment:/u);
  assert.match(organizationCaller, /pull_request_target:/u);
  assert.match(organizationCaller, /opened/u);
  assert.match(organizationCaller, /github\.event\.comment\.body == '\/review-all'/u);
  assert.match(organizationCaller, /ready_for_review/u);
  assert.match(organizationCaller, /synchronize/u);
  assert.match(organizationCaller, /reopened/u);
  assert.match(organizationCaller, /trigger: manual/u);
  assert.match(organizationCaller, /trigger: automatic/u);
  assert.match(
    organizationCaller,
    /group: organizational-review-caller-auto-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ github\.event\.pull_request\.head\.sha \}\}/u,
  );
  assert.match(organizationCaller, /cancel-in-progress: true/u);
  assert.doesNotMatch(organizationCaller, /\/review-claude/u);
  assert.doesNotMatch(organizationCaller, /Gemini/iu);
});

test("[4] посторонний автор, Draft и закрытый PR не запускают модели", () => {
  assert.equal(
    extractRunScript(caller, "Проверить и подтвердить ручную команду"),
    extractRunScript(organizationCaller, "Проверить и подтвердить ручную команду"),
  );
  for (const source of [caller, organizationCaller]) {
    const acknowledgeJob = extractJob(source, "acknowledge-manual");
    const manualJob = extractJob(source, "manual-review");
    assert.match(acknowledgeJob, /author_association == 'OWNER'/u);
    assert.match(acknowledgeJob, /author_association == 'MEMBER'/u);
    assert.match(acknowledgeJob, /author_association == 'COLLABORATOR'/u);
    assert.match(acknowledgeJob, /runs-on: ubuntu-24\.04/u);
    assert.match(acknowledgeJob, /timeout-minutes: 3/u);
    assert.match(acknowledgeJob, /permissions:\n\s+issues: write\n\s+pull-requests: read/u);
    assert.match(acknowledgeJob, /accepted: \$\{\{ steps\.ack\.outputs\.accepted \}\}/u);
    assert.match(manualJob, /needs: acknowledge-manual/u);
    assert.match(
      manualJob,
      /if: needs\.acknowledge-manual\.outputs\.accepted == 'true'/u,
    );
  }

  for (const prJson of [prFixture({ draft: true }), prFixture({ state: "closed" })]) {
    const result = executeRunScript({
      source: caller,
      stepName: "Проверить и подтвердить ручную команду",
      ghMock: acknowledgementGhMock,
      env: acknowledgementEnv({ MOCK_PR_JSON: prJson }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.outputs, /^accepted=false$/mu);
    assert.match(result.ghLog, /--raw-field content=confused/u);
  }

  const unauthorized = executeRunScript({
    source: caller,
    stepName: "Проверить и подтвердить ручную команду",
    ghMock: acknowledgementGhMock,
    env: acknowledgementEnv({
      MOCK_COMMENT_JSON: JSON.stringify({
        issue_url: "https://api.github.com/repos/Abrikosov-group/project/issues/17",
        body: "/review-all",
        user: { login: "mallory" },
        author_association: "NONE",
      }),
      TRIGGER_ACTOR: "mallory",
    }),
  });
  assert.notEqual(unauthorized.status, 0);
  assert.doesNotMatch(unauthorized.outputs, /^accepted=true$/mu);
});

test("[11] два существующих маркера не запускают модели и дают итоговый статус", () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const reviews = JSON.stringify([[
    {
      id: 101,
      user: { login: "github-actions[bot]" },
      body: `<!-- codex-review:${baseSha}:${headSha}:gpt-5.3-codex-spark -->\n<!-- review-findings:P0=0;P1=0;P2=0 -->`,
    },
    {
      id: 102,
      user: { login: "github-actions[bot]" },
      body: `<!-- claude-review:${baseSha}:${headSha}:claude-sonnet-5 -->\n<!-- review-findings:P0=0;P1=0;P2=0 -->`,
    },
  ]]);
  const commonEnv = {
    REPOSITORY: "Abrikosov-group/project",
    PR_NUMBER: "17",
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    TRIGGER: "automatic",
    REVIEW_PUBLISHER_LOGIN: "github-actions[bot]",
    REUSE_EXISTING_REVIEWS: "true",
    MOCK_PR_JSON: prFixture({ baseSha, headSha }),
    MOCK_REVIEWS_JSON: reviews,
  };
  const codex = executeRunScript({
    stepName: "Проверить дубликат и подготовить вход модели",
    ghMock: markerGhMock,
    commandMocks: { git: gitHeadMock },
    env: commonEnv,
  });
  const claude = executeRunScript({
    stepName: "Не расходовать квоту повторно для того же снимка",
    ghMock: markerGhMock,
    env: commonEnv,
  });

  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(claude.status, 0, claude.stderr);
  assert.match(codex.outputs, /^needed=false$/mu);
  assert.match(claude.outputs, /^needed=false$/mu);
  assert.match(
    extractJob(workflow, "analyze-codex"),
    /if: needs\.prepare-codex\.outputs\.review_needed == 'true'/u,
  );
  assert.match(
    extractJob(workflow, "analyze-claude"),
    /if: steps\.existing\.outputs\.needed == 'true'/u,
  );

  const finish = executeRunScript({
    stepName: "Показать результат обоих ревьюеров",
    ghMock: finishStatusGhMock,
    env: {
      REPOSITORY: "Abrikosov-group/project",
      PR_NUMBER: "17",
      STATUS_COMMENT_ID: "99",
      HEAD_SHA: headSha,
      MODE: "all",
      RUN_URL: "https://github.com/Abrikosov-group/project/actions/runs/1",
      CODEX_PREPARE_RESULT: "success",
      CODEX_REVIEW_NEEDED: "false",
      CODEX_ANALYZE_RESULT: "skipped",
      CODEX_PUBLISH_RESULT: "skipped",
      CODEX_PUBLISHED_BLOCKING_FINDINGS: "",
      CODEX_REUSED_BLOCKING_FINDINGS: "0",
      CLAUDE_ANALYZE_RESULT: "success",
      CLAUDE_REVIEW_NEEDED: "false",
      CLAUDE_PUBLISH_RESULT: "skipped",
      CLAUDE_PUBLISHED_BLOCKING_FINDINGS: "",
      CLAUDE_REUSED_BLOCKING_FINDINGS: "0",
      REVIEW_GATE_CONTEXT: "",
    },
  });
  assert.equal(finish.status, 0, finish.stderr);
  assert.match(finish.ghLog, /Двойное ИИ-ревью завершено/u);
  assert.match(finish.ghLog, /GPT-5\.3-Codex-Spark.*актуальное ревью уже существует/u);
  assert.match(finish.ghLog, /Claude Sonnet 5.*актуальное ревью уже существует/u);
});

test("повторно использованное ревью с P0–P2 не может сделать gate зелёным", () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const reviews = JSON.stringify([[
    {
      id: 201,
      user: { login: "github-actions[bot]" },
      body: `<!-- codex-review:${baseSha}:${headSha}:gpt-5.3-codex-spark -->\n<!-- review-findings:P0=0;P1=1;P2=0 -->`,
    },
    {
      id: 202,
      user: { login: "github-actions[bot]" },
      body: `<!-- claude-review:${baseSha}:${headSha}:claude-sonnet-5 -->\n<!-- review-findings:P0=0;P1=0;P2=0 -->`,
    },
  ]]);
  const commonEnv = {
    REPOSITORY: "Abrikosov-group/project",
    PR_NUMBER: "17",
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    TRIGGER: "automatic",
    REVIEW_PUBLISHER_LOGIN: "github-actions[bot]",
    REUSE_EXISTING_REVIEWS: "true",
    MOCK_PR_JSON: prFixture({ baseSha, headSha }),
    MOCK_REVIEWS_JSON: reviews,
  };
  const codex = executeRunScript({
    stepName: "Проверить дубликат и подготовить вход модели",
    ghMock: markerGhMock,
    commandMocks: { git: gitHeadMock },
    env: commonEnv,
  });
  const claude = executeRunScript({
    stepName: "Не расходовать квоту повторно для того же снимка",
    ghMock: markerGhMock,
    env: commonEnv,
  });
  assert.match(codex.outputs, /^blocking_findings=1$/mu);
  assert.match(claude.outputs, /^blocking_findings=0$/mu);

  const finish = executeRunScript({
    stepName: "Показать результат обоих ревьюеров",
    ghMock: finishStatusGhMock,
    env: {
      REPOSITORY: "Abrikosov-group/project",
      PR_NUMBER: "17",
      STATUS_COMMENT_ID: "99",
      HEAD_SHA: headSha,
      MODE: "all",
      RUN_URL: "https://github.com/Abrikosov-group/project/actions/runs/1",
      CODEX_PREPARE_RESULT: "success",
      CODEX_REVIEW_NEEDED: "false",
      CODEX_ANALYZE_RESULT: "skipped",
      CODEX_PUBLISH_RESULT: "skipped",
      CODEX_PUBLISHED_BLOCKING_FINDINGS: "",
      CODEX_REUSED_BLOCKING_FINDINGS: "1",
      CLAUDE_ANALYZE_RESULT: "success",
      CLAUDE_REVIEW_NEEDED: "false",
      CLAUDE_PUBLISH_RESULT: "skipped",
      CLAUDE_PUBLISHED_BLOCKING_FINDINGS: "",
      CLAUDE_REUSED_BLOCKING_FINDINGS: "0",
      REVIEW_GATE_CONTEXT: "ИИ-ревью / Готовность",
    },
  });
  assert.equal(finish.status, 0, finish.stderr);
  assert.match(finish.ghLog, /Блокирующих замечаний P0–P2: \*\*1\*\*/u);
  assert.match(finish.ghLog, /--raw-field state=failure/u);
  assert.doesNotMatch(finish.ghLog, /--raw-field state=success/u);
});

test("ручное ревью Claude с P0–P2 не показывает зелёный итог", () => {
  const headSha = "b".repeat(40);
  const finish = executeRunScript({
    stepName: "Показать результат обоих ревьюеров",
    ghMock: finishStatusGhMock,
    env: {
      REPOSITORY: "Abrikosov-group/project",
      PR_NUMBER: "17",
      STATUS_COMMENT_ID: "99",
      HEAD_SHA: headSha,
      MODE: "claude",
      RUN_URL: "https://github.com/Abrikosov-group/project/actions/runs/1",
      CODEX_PREPARE_RESULT: "skipped",
      CODEX_REVIEW_NEEDED: "false",
      CODEX_ANALYZE_RESULT: "skipped",
      CODEX_PUBLISH_RESULT: "skipped",
      CODEX_PUBLISHED_BLOCKING_FINDINGS: "",
      CODEX_REUSED_BLOCKING_FINDINGS: "",
      CLAUDE_ANALYZE_RESULT: "success",
      CLAUDE_REVIEW_NEEDED: "true",
      CLAUDE_PUBLISH_RESULT: "success",
      CLAUDE_PUBLISHED_BLOCKING_FINDINGS: "1",
      CLAUDE_REUSED_BLOCKING_FINDINGS: "",
      REVIEW_GATE_CONTEXT: "",
    },
  });

  assert.equal(finish.status, 0, finish.stderr);
  assert.match(finish.ghLog, /ИИ-ревью требует внимания/u);
  assert.match(finish.ghLog, /Блокирующих замечаний P0–P2: \*\*1\*\*/u);
  assert.doesNotMatch(finish.ghLog, /✅ Ручное ревью Claude завершено/u);
});

test("старое ревью без доверенных метрик запускает модель повторно", () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const commonEnv = {
    REPOSITORY: "Abrikosov-group/project",
    PR_NUMBER: "17",
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    TRIGGER: "automatic",
    REVIEW_PUBLISHER_LOGIN: "github-actions[bot]",
    REUSE_EXISTING_REVIEWS: "true",
    MOCK_PR_JSON: prFixture({ baseSha, headSha }),
    MOCK_REVIEWS_JSON: JSON.stringify([[
      {
        id: 301,
        user: { login: "github-actions[bot]" },
        body: `<!-- codex-review:${baseSha}:${headSha}:gpt-5.3-codex-spark -->`,
      },
    ]]),
  };
  const codex = executeRunScript({
    stepName: "Проверить дубликат и подготовить вход модели",
    ghMock: markerGhMock,
    commandMocks: { git: gitHeadMock },
    env: commonEnv,
  });
  assert.equal(codex.status, 0, codex.stderr);
  assert.match(codex.outputs, /^needed=true$/mu);
  assert.match(codex.stdout, /не содержит доверенных метрик/u);
});

test("повторяющиеся и небезопасные метрики не считаются доверенными", () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const cases = [
    {
      stepName: "Проверить дубликат и подготовить вход модели",
      marker: `<!-- codex-review:${baseSha}:${headSha}:gpt-5.3-codex-spark -->`,
      commandMocks: { git: gitHeadMock },
    },
    {
      stepName: "Не расходовать квоту повторно для того же снимка",
      marker: `<!-- claude-review:${baseSha}:${headSha}:claude-sonnet-5 -->`,
      commandMocks: {},
    },
  ];
  const metricBodies = [
    "<!-- review-findings:P0=0;P1=0;P2=0 -->\n<!-- review-findings:P0=0;P1=1;P2=0 -->",
    "<!-- review-findings:P0=9007199254740992;P1=0;P2=0 -->",
  ];

  for (const { stepName, marker, commandMocks } of cases) {
    for (const metrics of metricBodies) {
      const result = executeRunScript({
        stepName,
        ghMock: markerGhMock,
        commandMocks,
        env: {
          REPOSITORY: "Abrikosov-group/project",
          PR_NUMBER: "17",
          BASE_SHA: baseSha,
          HEAD_SHA: headSha,
          TRIGGER: "automatic",
          REVIEW_PUBLISHER_LOGIN: "github-actions[bot]",
          REUSE_EXISTING_REVIEWS: "true",
          MOCK_PR_JSON: prFixture({ baseSha, headSha }),
          MOCK_REVIEWS_JSON: JSON.stringify([[
            {
              id: 302,
              user: { login: "github-actions[bot]" },
              body: `${marker}\n${metrics}`,
            },
          ]]),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.outputs, /^needed=true$/mu);
      assert.doesNotMatch(result.outputs, /^blocking_findings=/mu);
    }
  }
});

test("из нескольких ручных ревью одного SHA gate берёт самое новое", () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const codexMarker = `<!-- codex-review:${baseSha}:${headSha}:gpt-5.3-codex-spark -->`;
  const codex = executeRunScript({
    stepName: "Проверить дубликат и подготовить вход модели",
    ghMock: markerGhMock,
    commandMocks: { git: gitHeadMock },
    env: {
      REPOSITORY: "Abrikosov-group/project",
      PR_NUMBER: "17",
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      TRIGGER: "automatic",
      REVIEW_PUBLISHER_LOGIN: "github-actions[bot]",
      REUSE_EXISTING_REVIEWS: "true",
      MOCK_PR_JSON: prFixture({ baseSha, headSha }),
      MOCK_REVIEWS_JSON: JSON.stringify([[
        {
          id: 401,
          user: { login: "github-actions[bot]" },
          body: `${codexMarker}\n<!-- review-findings:P0=0;P1=1;P2=0 -->`,
        },
        {
          id: 402,
          user: { login: "github-actions[bot]" },
          body: `${codexMarker}\n<!-- review-findings:P0=0;P1=0;P2=0 -->`,
        },
      ]]),
    },
  });
  assert.equal(codex.status, 0, codex.stderr);
  assert.match(codex.outputs, /^blocking_findings=0$/mu);
});

test("ручной запуск и отключённое переиспользование принудительно публикуют новое ревью", () => {
  for (const jobId of ["publish-codex", "publish-claude"]) {
    assert.match(
      extractJob(workflow, jobId),
      /FORCE_REVIEW: \$\{\{ needs\.context\.outputs\.trigger == 'manual' \|\| inputs\.reuse_existing_reviews == false \}\}/u,
    );
  }
});

test("[12] любой один маркер запускает только отсутствующую модель", () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const cases = [
    {
      marker: `<!-- codex-review:${baseSha}:${headSha}:gpt-5.3-codex-spark -->\n<!-- review-findings:P0=0;P1=0;P2=0 -->`,
      codexNeeded: "false",
      claudeNeeded: "true",
    },
    {
      marker: `<!-- claude-review:${baseSha}:${headSha}:claude-sonnet-5 -->\n<!-- review-findings:P0=0;P1=0;P2=0 -->`,
      codexNeeded: "true",
      claudeNeeded: "false",
    },
  ];

  for (const { marker, codexNeeded, claudeNeeded } of cases) {
    const commonEnv = {
      REPOSITORY: "Abrikosov-group/project",
      PR_NUMBER: "17",
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      TRIGGER: "automatic",
      REVIEW_PUBLISHER_LOGIN: "github-actions[bot]",
      REUSE_EXISTING_REVIEWS: "true",
      MOCK_PR_JSON: prFixture({ baseSha, headSha }),
      MOCK_REVIEWS_JSON: JSON.stringify([[
        { id: 101, user: { login: "github-actions[bot]" }, body: marker },
      ]]),
    };
    const codex = executeRunScript({
      stepName: "Проверить дубликат и подготовить вход модели",
      ghMock: markerGhMock,
      commandMocks: { git: gitHeadMock },
      env: commonEnv,
    });
    const claude = executeRunScript({
      stepName: "Не расходовать квоту повторно для того же снимка",
      ghMock: markerGhMock,
      env: commonEnv,
    });

    assert.equal(codex.status, 0, codex.stderr);
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(codex.outputs, new RegExp(`^needed=${codexNeeded}$`, "mu"));
    assert.match(claude.outputs, new RegExp(`^needed=${claudeNeeded}$`, "mu"));
  }

  assert.match(
    extractJob(workflow, "analyze-codex"),
    /if: needs\.prepare-codex\.outputs\.review_needed == 'true'/u,
  );
  assert.match(
    extractJob(workflow, "analyze-claude"),
    /if: steps\.existing\.outputs\.needed == 'true'/u,
  );
});

test("[13] ручная команда проходит переходы 👀 → 🚀 и 👀 → 😕", () => {
  const acknowledge = executeRunScript({
    source: caller,
    stepName: "Проверить и подтвердить ручную команду",
    ghMock: acknowledgementGhMock,
    env: acknowledgementEnv(),
  });
  assert.equal(acknowledge.status, 0, acknowledge.stderr);
  assert.match(acknowledge.outputs, /^accepted=true$/mu);
  assert.match(acknowledge.ghLog, /--raw-field content=eyes/u);

  const start = executeRunScript({
    stepName: "Поставить 🚀 и опубликовать статус запуска",
    ghMock: statusGhMock,
    env: statusEnv({
      MOCK_REACTIONS_JSON: slurpedReactions(
        reaction(11, "eyes"),
        reaction(12, "eyes", "alice"),
      ),
    }),
  });
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.ghLog, /--raw-field content=rocket/u);
  assert.match(start.ghLog, /--method DELETE.*\/issues\/comments\/91\/reactions\/11/u);
  assert.doesNotMatch(start.ghLog, /\/issues\/comments\/91\/reactions\/12/u);

  const finalize = executeRunScript({
    source: caller,
    stepName: "Завершить отображение ручной команды",
    ghMock: acknowledgementGhMock,
    env: statusEnv({
      MOCK_REACTIONS_JSON: slurpedReactions(
        reaction(21, "eyes"),
        reaction(22, "eyes", "alice"),
      ),
    }),
  });
  assert.equal(finalize.status, 0, finalize.stderr);
  assert.match(finalize.ghLog, /--method DELETE.*\/issues\/comments\/91\/reactions\/21/u);
  assert.doesNotMatch(finalize.ghLog, /\/issues\/comments\/91\/reactions\/22/u);
  assert.match(finalize.ghLog, /--raw-field content=confused/u);
});

test("[14] ошибка удаления 👀 в start-status не блокирует модели", () => {
  const result = executeRunScript({
    stepName: "Поставить 🚀 и опубликовать статус запуска",
    ghMock: statusGhMock,
    env: statusEnv({
      MOCK_REACTIONS_JSON: slurpedReactions(reaction(31, "eyes")),
      MOCK_DELETE_FAILURE_ID: "31",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning::/u);
  assert.match(result.outputs, /^comment_id=99$/mu);
});

test("[15][18] финализатор имеет точный гейт и идемпотентно обеспечивает 😕", () => {
  assert.equal(
    extractRunScript(caller, "Завершить отображение ручной команды"),
    extractRunScript(organizationCaller, "Завершить отображение ручной команды"),
  );
  for (const source of [caller, organizationCaller]) {
    const finalizer = extractJob(source, "finalize-manual-ack");
    assert.match(finalizer, /needs: \[acknowledge-manual, manual-review\]/u);
    assert.match(
      finalizer,
      /if: \$\{\{ always\(\) && needs\.acknowledge-manual\.result != 'skipped' \}\}/u,
    );
    assert.match(finalizer, /runs-on: ubuntu-24\.04/u);
    assert.match(finalizer, /timeout-minutes: 3/u);
    assert.match(finalizer, /permissions:\n\s+issues: write/u);
    assert.doesNotMatch(finalizer, /pull-requests:/u);
  }

  for (const reactions of [
    slurpedReactions(),
    slurpedReactions(reaction(41, "eyes")),
    slurpedReactions(reaction(42, "confused")),
  ]) {
    const result = executeRunScript({
      source: caller,
      stepName: "Завершить отображение ручной команды",
      ghMock: acknowledgementGhMock,
      env: statusEnv({ MOCK_REACTIONS_JSON: reactions }),
    });
    assert.equal(result.status, 0, result.stderr);
    const confusedPosts = result.ghLog.match(/--raw-field content=confused/gu) ?? [];
    assert.equal(confusedPosts.length, reactions.includes('"content":"confused"') ? 0 : 1);
  }

  for (const env of [
    statusEnv({
      MOCK_REACTIONS_JSON: slurpedReactions(reaction(43, "eyes")),
      MOCK_DELETE_FAILURE_ID: "43",
    }),
    statusEnv({
      MOCK_REACTIONS_JSON: slurpedReactions(),
      MOCK_POST_FAILURE_CONTENT: "confused",
    }),
  ]) {
    const result = executeRunScript({
      source: caller,
      stepName: "Завершить отображение ручной команды",
      ghMock: acknowledgementGhMock,
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::/u);
  }
});

test("[16] полный повтор очищает только старые реакции бота", () => {
  const result = executeRunScript({
    source: caller,
    stepName: "Проверить и подтвердить ручную команду",
    ghMock: acknowledgementGhMock,
    env: acknowledgementEnv({
      RUN_ATTEMPT: "2",
      MOCK_REACTIONS_JSON: slurpedReactions(
        reaction(51, "eyes"),
        reaction(52, "rocket"),
        reaction(53, "confused"),
        reaction(54, "eyes", "alice"),
      ),
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.ghLog, /--method DELETE.*\/issues\/comments\/91\/reactions\/51/u);
  assert.match(result.ghLog, /--method DELETE.*\/issues\/comments\/91\/reactions\/52/u);
  assert.match(result.ghLog, /--method DELETE.*\/issues\/comments\/91\/reactions\/53/u);
  assert.doesNotMatch(result.ghLog, /\/issues\/comments\/91\/reactions\/54/u);

  const cleanupFailure = executeRunScript({
    source: caller,
    stepName: "Проверить и подтвердить ручную команду",
    ghMock: acknowledgementGhMock,
    env: acknowledgementEnv({
      RUN_ATTEMPT: "2",
      MOCK_REACTIONS_JSON: slurpedReactions(reaction(55, "eyes")),
      MOCK_DELETE_FAILURE_ID: "55",
    }),
  });
  assert.notEqual(cleanupFailure.status, 0);
  assert.doesNotMatch(cleanupFailure.outputs, /^accepted=true$/mu);
});

test("workflow сразу показывает запуск и обновляет единый статусный комментарий", () => {
  const startStatus = workflow.match(/\n  start-status:[\s\S]*?(?=\n  prepare-codex:)/u)?.[0];
  const finishStatus = workflow.match(/\n  finish-status:[\s\S]*$/u)?.[0];

  assert.ok(startStatus);
  assert.ok(finishStatus);
  assert.match(startStatus, /Поставить 🚀 и опубликовать статус запуска/u);
  assert.match(startStatus, /--raw-field content='rocket'/u);
  assert.match(startStatus, /<!-- organizational-review-status -->/u);
  assert.match(startStatus, /GPT-5\.3-Codex-Spark \(\\`xhigh\\`\) — запущен/u);
  assert.match(startStatus, /Claude Sonnet 5 \(\\`xhigh\\`\) — запущен/u);
  assert.match(startStatus, /echo "comment_id=\$\{comment_id\}"/u);
  assert.match(finishStatus, /always\(\)/u);
  assert.match(finishStatus, /Двойное ИИ-ревью завершено/u);
  assert.match(finishStatus, /ИИ-ревью требует внимания/u);
  assert.match(finishStatus, /Блокирующих замечаний P0–P2/u);
  assert.match(finishStatus, /statuses\/\$\{HEAD_SHA\}/u);
  assert.match(finishStatus, /current_head_sha/u);
  assert.match(finishStatus, /Статус не обновляется: PR уже содержит более новый commit/u);
  assert.match(finishStatus, /--method PATCH/u);
  assert.match(workflow, /needs: \[context, start-status\]/u);
  assert.ok(workflow.indexOf("  start-status:") < workflow.indexOf("  prepare-codex:"));
  assert.doesNotMatch(workflow, /\n  acknowledge:/u);
});

test("пользовательская документация описывает ровно два ревью", () => {
  assert.match(contributing, /проверку двумя ревьюерами/u);
  assert.doesNotMatch(contributing, /тремя ревьюерами/u);
  assert.match(contributing, /после каждого нового коммита/u);
  assert.match(contributing, /реакц/u);
  assert.match(contributing, /статусн/u);
  assert.doesNotMatch(contributing, /\/review-claude/u);
  assert.match(pullRequestTemplate, /GPT-5\.3-Codex-Spark и Claude Sonnet 5/u);
  assert.doesNotMatch(pullRequestTemplate, /Codex, Claude и Gemini/u);
});

test("[17] README и CONTRIBUTING описывают очередь и реакции R4", () => {
  for (const document of [readFileSync("README.md", "utf8"), contributing]) {
    assert.match(document, /👀/u);
    assert.match(document, /🚀/u);
    assert.match(document, /😕/u);
    assert.match(document, /очеред/u);
    assert.doesNotMatch(document, /сразу ставит[^\n]*🚀/u);
  }
});
