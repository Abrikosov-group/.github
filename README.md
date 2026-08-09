# .github

Единые правила разработки и шаблоны для репозиториев `Abrikosov-group`.

## Организационное ИИ-ревью

Центральный reusable workflow `.github/workflows/review-all.yml` выполняет
двойное ревью pull request:

- GPT-5.3-Codex-Spark с усилием `xhigh` через Codex CLI на защищённом
  self-hosted runner и оплаченный вход ChatGPT;
- Claude Sonnet 5 с усилием `xhigh` через подписочный OAuth Claude Code.

Gemini и платные API-ключи моделей не используются.

Codex запускается командой `codex exec --model gpt-5.3-codex-spark` с
`model_reasoning_effort="xhigh"`. Workflow не вызывает `@codex review`, не
использует квоту встроенного Security Review и не требует OpenAI API-ключ.
Точный diff передаётся модели без checkout недоверенного PR на сервере, а
результат проходит строгую проверку перед публикацией.

Runner group `codex-spark-review` должен быть доступен всем подключённым
репозиториям организации и ограничен этим reusable workflow. На runner должен
быть выполнен подписочный вход `codex login`; его `CODEX_HOME` сохраняется между
запусками. Diff для одного запуска Codex ограничен 512 KiB.

Репозитории подключают workflow маленьким файлом
`.github/workflows/review-all.yml`. Для нового репозитория используйте
организационный шаблон **«Двойное ИИ-ревью Codex и Claude»** во вкладке
**Actions → New workflow**.

Шаблон вызывает центральный workflow по полному commit SHA. Обновление версии
в подключённых репозиториях выполняется отдельным проверяемым изменением.

Доступные команды в комментарии готового PR:

```text
/review-all
/review-claude
```

`/review-all` запускает Codex и Claude. `/review-claude` повторяет только Claude.
