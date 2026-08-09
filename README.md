# .github

Единые правила разработки и шаблоны для репозиториев `Abrikosov-group`.

## Организационное ИИ-ревью

Центральный reusable workflow `.github/workflows/review-all.yml` выполняет
двойное ревью pull request:

- Codex Review через установленный GitHub Connector;
- Claude Sonnet 5 с усилием `xhigh` через подписочный OAuth Claude Code.

Gemini и платные API-ключи моделей не используются.

Workflow ожидает фактическое завершение Codex Review и проверяет, что ответ
относится к тому же Head SHA, который анализирует Claude. Модель Codex
выбирается самой GitHub-интеграцией: документированный интерфейс
`@codex review` не предоставляет параметр модели, поэтому workflow не заявляет
неподтверждаемую модель Codex.

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
