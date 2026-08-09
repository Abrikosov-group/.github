# .github

Единые правила разработки и шаблоны для репозиториев `Abrikosov-group`.

## Организационное ИИ-ревью

Центральный reusable workflow `.github/workflows/review-all.yml` выполняет
двойное ревью pull request:

- Codex Review через установленный GitHub Connector;
- Claude Sonnet 4.6 с усилием `high` через подписочный OAuth Claude Code.

Gemini и платные API-ключи моделей не используются.

Репозитории подключают workflow маленьким файлом
`.github/workflows/review-all.yml`. Для нового репозитория используйте
организационный шаблон **«Двойное ИИ-ревью Codex и Claude»** во вкладке
**Actions → New workflow**.

Доступные команды в комментарии готового PR:

```text
/review-all
/review-claude
```

`/review-all` запускает Codex и Claude. `/review-claude` повторяет только Claude.
