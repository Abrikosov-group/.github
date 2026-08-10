import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/review-all.yml", "utf8");
const caller = readFileSync("workflow-templates/review-all.yml", "utf8");
const organizationCaller = readFileSync(".github/workflows/review-all-trigger.yml", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const pullRequestTemplate = readFileSync(".github/pull_request_template.md", "utf8");

test("организационный workflow запускает только Codex и Claude", () => {
  assert.match(workflow, /--model gpt-5\.3-codex-spark/u);
  assert.match(workflow, /claude-sonnet-5/u);
  assert.doesNotMatch(workflow, /@codex review/u);
  assert.doesNotMatch(workflow, /\/gemini\s+review/iu);
  assert.doesNotMatch(workflow, /gemini_url|dispatch-gemini/iu);
  assert.doesNotMatch(workflow, /\/review-claude/u);
});

test("Codex использует подписочный Spark xhigh на защищённом Runner", () => {
  assert.match(workflow, /group: codex-spark-review/u);
  assert.match(workflow, /EXPECTED_RUNNER_NAME: codex-spark-review-187-127-26-1/u);
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

test("ручной источник проверяется без хрупкого сравнения полного API URL", () => {
  assert.match(workflow, /TRIGGER_ACTOR: \$\{\{ github\.actor \}\}/u);
  assert.match(workflow, /capture\("\/issues\/\(\?<number>\[1-9\]\[0-9\]\*\)\$"\)/u);
  assert.match(workflow, /"\$\{comment_author\}" != "\$\{TRIGGER_ACTOR\}"/u);
  assert.match(workflow, /case "\$\{comment_author_association\}" in/u);
  assert.doesNotMatch(workflow, /expected_issue_url/u);
});

test("ограничения main и same-repo применяются только к автоматическому запуску", () => {
  assert.match(
    workflow,
    /if \[\[ "\$\{TRIGGER\}" == "automatic" &&\s+\("\$\{base_ref\}" != "main" \|\| "\$\{head_repository\}" != "\$\{REPOSITORY\}"\) \]\]/u,
  );
  assert.match(
    workflow,
    /if \[\[ ! "\$\{base_sha\}" =~ \^\[0-9a-f\]\{40\}\$ \|\| ! "\$\{head_sha\}" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u,
  );
  assert.doesNotMatch(
    workflow,
    /if \[\[ "\$\{base_ref\}" != "main" \|\| "\$\{head_repository\}" != "\$\{REPOSITORY\}"/u,
  );
});

test("автоматический источник закрепляет точный Head готового PR", () => {
  assert.match(workflow, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.match(workflow, /opened\|ready_for_review\|synchronize\|reopened/u);
  assert.match(workflow, /event_head_repository/u);
  assert.match(workflow, /event_draft/u);
  assert.match(workflow, /head_sha\}" != "\$\{EXPECTED_HEAD_SHA\}/u);
  assert.match(
    workflow,
    /group: organizational-review-engine-\$\{\{ inputs\.repository \}\}-\$\{\{ inputs\.pr_number \}\}-\$\{\{ inputs\.trigger == 'automatic' && 'automatic'/u,
  );
  assert.match(workflow, /format\('manual-\{0\}', inputs\.comment_id\)/u);
  assert.match(workflow, /выбран текущий Head \$\{head_sha\}/u);
  assert.doesNotMatch(workflow, /Head PR изменился после автоматического события/u);
  assert.match(workflow, /cancel-in-progress: true/u);
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
  assert.match(caller, /group: organizational-review-caller-auto-/u);
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
  assert.match(organizationCaller, /group: organizational-review-caller-auto-/u);
  assert.match(organizationCaller, /cancel-in-progress: true/u);
  assert.doesNotMatch(organizationCaller, /\/review-claude/u);
  assert.doesNotMatch(organizationCaller, /Gemini/iu);
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
  assert.match(finishStatus, /Двойное ИИ-ревью требует внимания/u);
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
