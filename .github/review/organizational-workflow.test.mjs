import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/review-all.yml", "utf8");
const caller = readFileSync("workflow-templates/review-all.yml", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const pullRequestTemplate = readFileSync(".github/pull_request_template.md", "utf8");

test("организационный workflow запускает только Codex и Claude", () => {
  assert.match(workflow, /@codex review/u);
  assert.match(workflow, /claude-sonnet-5/u);
  assert.doesNotMatch(workflow, /\/gemini\s+review/iu);
  assert.doesNotMatch(workflow, /gemini_url|dispatch-gemini/iu);
});

test("Codex подтверждает завершение ревью для точного Head", () => {
  assert.match(workflow, /HEAD_SHA: \$\{\{ needs\.context\.outputs\.head_sha \}\}/u);
  assert.match(workflow, /codex-review-request:\$\{BASE_SHA\}:\$\{HEAD_SHA\}:\$\{COMMENT_ID\}/u);
  assert.match(workflow, /chatgpt-codex-connector\[bot\]/u);
  assert.match(workflow, /Codex подтвердил ревью commit \$\{HEAD_SHA\}/u);
  assert.match(workflow, /Codex не подтвердил ревью commit \$\{HEAD_SHA\}/u);
});

test("точный diff строится локально без лимита GitHub Diff API", () => {
  assert.match(workflow, /git fetch --no-tags --no-recurse-submodules --depth=1/u);
  assert.match(workflow, /origin "refs\/pull\/\$\{PR_NUMBER\}\/head"/u);
  assert.match(workflow, /git diff --binary --find-renames --full-index/u);
  assert.doesNotMatch(workflow, /application\/vnd\.github\.diff/u);
});

test("исполняемый организационный код закреплён полными SHA", () => {
  assert.doesNotMatch(workflow, /\n\s+ref: main\s*$/mu);
  assert.match(workflow, /repository: Abrikosov-group\/\.github[\s\S]*?ref: [0-9a-f]{40}/u);
  assert.match(
    caller,
    /Abrikosov-group\/\.github\/\.github\/workflows\/review-all\.yml@[0-9a-f]{40}/u,
  );
  assert.doesNotMatch(caller, /review-all\.yml@main/u);
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

test("источник команды проверяется без хрупкого сравнения полного API URL", () => {
  assert.match(workflow, /TRIGGER_ACTOR: \$\{\{ github\.actor \}\}/u);
  assert.match(workflow, /capture\("\/issues\/\(\?<number>\[1-9\]\[0-9\]\*\)\$"\)/u);
  assert.match(workflow, /"\$\{comment_author\}" != "\$\{TRIGGER_ACTOR\}"/u);
  assert.match(workflow, /case "\$\{comment_author_association\}" in/u);
  assert.doesNotMatch(workflow, /expected_issue_url/u);
});

test("шаблон слушает комментарии и вызывает центральный workflow", () => {
  assert.match(caller, /issue_comment:/u);
  assert.match(caller, /github\.event\.comment\.body == '\/review-all'/u);
  assert.match(
    caller,
    /Abrikosov-group\/\.github\/\.github\/workflows\/review-all\.yml@[0-9a-f]{40}/u,
  );
  assert.match(caller, /REVIEW_DISPATCH_TOKEN: \$\{\{ secrets\.REVIEW_DISPATCH_TOKEN \}\}/u);
  assert.match(caller, /CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/u);
});

test("пользовательская документация описывает ровно два ревью", () => {
  assert.match(contributing, /проверку двумя ревьюерами/u);
  assert.doesNotMatch(contributing, /тремя ревьюерами/u);
  assert.match(pullRequestTemplate, /Codex и Claude Sonnet 5/u);
  assert.doesNotMatch(pullRequestTemplate, /Codex, Claude и Gemini/u);
});
