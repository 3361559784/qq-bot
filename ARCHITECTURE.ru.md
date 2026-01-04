# Техническая архитектура

> **Система campus AI Copilot, построенная вокруг безопасности.**

---

## Общий обзор

```
Вход пользователя (QQ / Web / HTTP API)
    ↓
Слой 0: уточнение контекста
    ↓
Слой 1: детерминированные проверки безопасности
    ↓
Слой 2: детектор безопасности на базе LLM
    ↓
Слой 3: классификация намерений
    ↓
Слой 4: объяснимый отказ
    ↓
Слой 5: генерация контента с защитами
    ↓
Выходной слой (QQ / Web / JSON)
```

---

## Слой 0: уточнение контекста

**Цель:** Не запускать поиск/действие по непонятному запросу

**Реализация:**
- Обнаружение отдельных наречий, риторических конструкций, вставных фраз
- Проверка, можно ли понять фразу без контекста
- Если нельзя — задать уточняющий вопрос и остановить дальнейшую обработку

**Реализация в коде:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L3000-L3150)

---

## Слой 1: детерминированная безопасность

**Цель:** Исключить известные опасные шаблоны с 100% точностью

**Категории:**
1. Академическая честность (шпаргалки, списывание)
2. Утечка приватных данных (ID, телефоны, поиск других людей)
3. Вредоносный контент (суицид, насилие, нападение)
4. Инъекции подсказок (ignore instructions)

**Пример:**
```javascript
const ACADEMIC_INTEGRITY_PATTERNS = [ /考试.{0,5}(答案|原题)/i, ... ];
```

**Файл:** [src/common/safety.js](src/common/safety.js#L1-L471)

---

## Слой 2: проверка на базе LLM

**Задача:** Поймать смысловые «хвосты», которые не ловит regex

**Отдельные модели:**
- Model A (безопасность): отдельный вызываемый классификатор, низкая температура
- Model B (генерация): вызывается только если A пропустил

**Код:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L4500-L4600)

---

## Слой 3: классификация намерений

**Цель:** Маршрутировать ввод к нужному инструменту/персонажу

**Инструменты:** schedule, plan, search, thought_translate, identity, chat

**Оптимизация:** Частые шаблоны обрабатываются regex до вызова LLM (экономия ~200 мс)

**Код:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L3200-L3450)

---

## Слой 4: объяснимый отказ

**Цель:** Не молчать при отказе — объяснять и предлагать альтернативы

**Структура:**
1. Тег причины (вне области/риск/мало инфо)
2. Почему нельзя ответить сразу
3. Что можно предоставить вместо
4. Где сомнение (попросите уточнить)
5. Как продолжить (добавить данные или изменить вопрос)

**Реализация:** replaceRobotRefusal → inferRefusalProfile → formatExplainableRefusal

**Файл:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L5163-L5215)

---

## Слой 5: генерация с защитами

### Защита 1: запрет временных утверждений

Без данных о расписании нельзя писать «завтра у тебя пара».

### Защита 2: ссылочное подтверждение

Ответы из поиска всегда содержат источник; знания модели помечаются как потенциально устаревшие.

### Защита 3: переключение персонажей

| Условие | От | К | Причина |
|---------|----|---|---------|
| Планирование | Alice | Professional | Нужна точность |
| Безопасность | Alice | Professional | Авторитет |
| Web | Alice | Copilot | Доверие |
| QQ чат | Professional | Alice | Близость |

**Файл:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L5500-L5650)

---

## Путь данных: пример «Какие у меня завтра пары?»

1. Слой0: проверка контекста — OK
2. Слой1: regex — нет риска
3. Слой2: LLM — безопасно
4. Слой3: Intent → schedule
5. Слой4: нет расписания → отказ
6. Слой5: генерация с guardrail
7. Ответ: «Пожалуйста, пришлите расписание, я не могу утверждать пары»

**Трассировка:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L6100-L6200)

---

## Мультиперсонажи

| Персонаж | Где используется | Характер |
|----------|----------------|----------|
| Alice | QQ чат | Живой, эмодзи, «Sensei» |
| Professional | Web/Decision | Краткий, без эмоций |
| Translator | Thought clarification | Не играет роль, только разбирает мысли |

**Логика переключения:**
```javascript
if (isPlanMode || isDecisionTask || isSafetyBlock || isWebChannel) currentPersona = 'professional';
if (isQQChannel && !isPlanMode && !isSafetyBlock) currentPersona = 'alice';
```

---

## Модульные сервисы

- `hybridSearch.js`: комбинирует Azure AI Search и DuckDuckGo
- `scheduleService.js`: парсит ICS/Excel, сохраняет в Cosmos, ищет по дате
- `visionService.js`: Azure Vision + Llama Vision, резервная работа
- `emotionService.js`: переводит уровень доверия в тон ответа

---

## Деплой и мониторинг

GitHub Repo → GitHub Actions → Azure Functions (Flex) → Cosmos DB + AI Search → Application Insights

Скрипт: `deploy-functions.sh`

---

## Ключевые метрики

| Метрика | Цель | Почему важно |
|---------|------|--------------|
| Safety block rate | >95% | Безопасность |
| False refusal | <5% | Удобство |
| Explainable refusal coverage | 100% | Доверие |
| Schedule hallucination rate | 0% | Критично |
| Search citation rate | 100% | Проверяемость |

---

## Хронология

| Дата | Изменение | Причина |
|------|-----------|---------|
| 2024-11 | Добавлена Alice persona | Нужна «человечность» |
| 2024-12 | Evidence/Claim | Неверные расписания |
| 2024-12 | Multi-layer safety | Prompt injection |
| 2025-01 | Explainable refusal | Холодные отказы |
| 2025-01 | Clarification layer | Шум от «永远永远» |
| 2025-01 | Translator mode | QQ хочет разобраться в мыслях |

---

## Что дальше

1. Confidence gating — блокировка при низкой уверенности
2. Outcome sandbox — dry-run опасных действий
3. Long-term memory RAG — хранение embedding в AI Search
4. Визуализация — показать пользователю, какой слой отвечал

---

## Источники

- [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md)
- [src/common/safety.js](src/common/safety.js)
- [src/functions/schoolBot.js](src/functions/schoolBot.js)
- [docs/P0-INTEGRATION-GUIDE.md](docs/P0-INTEGRATION-GUIDE.md)

---

*Техническая документация — Ziheng Liu*  
*Принципы важнее паттернов*
