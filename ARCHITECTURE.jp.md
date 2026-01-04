> **Languages**: [English](ARCHITECTURE.md) | [中文](ARCHITECTURE.zh.md) | [日本語](ARCHITECTURE.jp.md) | [Русский](ARCHITECTURE.ru.md)

# 技術アーキテクチャ

> **安全性を最優先するキャンパス AI Copilot のシステム構成図です。**

---

## システム概要

```
ユーザー入力（QQ / Web / HTTP API）
    ↓
第0層：文脈明確化（曖昧な入力は質問してから進む）
    ↓
第1層：決定的安全チェック（正規表現ルール）
    ↓
第2層：LLMによる安全検出（意味的分析）
    ↓
第3層：意図分類（ツール/ペルソナへのルーティング）
    ↓
第4層：説明可能な拒否レイヤー（原因タグ＋代替＋次の一手）
    ↓
第5層：ガード付き生成（時間主張防止、証拠表記、ペルソナ切り替え）
    ↓
応答出力（QQ / Web / JSON）
```

---

## 第0層：文脈の明確化

**目的**：曖昧な入力に対して即検索/実行しない

**実装**：
- 裸の副詞、修辞強調、カッコ補足を検出
- 単独で意味が通じるか判定
- 不可なら澄んだ質問を提示し後続処理を止める

**コード箇所**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L3000-L3150)

---

## 第1層：決定的安全チェック

**目的**：既知の危険パターンを100%でブロック

**カテゴリ**：
1. 学術不正（カンニング、代行、試験回答）
2. プライバシー漏洩（ID、電話番号、他人の情報）
3. 有害内容（自殺、暴力、攻撃）
4. プロンプトインジェクション（指示無視など）

**実装例**：
```javascript
const ACADEMIC_INTEGRITY_PATTERNS = [ /試験.{0,5}(答案|原題)/i, ... ];
```

**コード箇所**：[src/common/safety.js](src/common/safety.js#L1-L471)

---

## 第2層：LLM 安全検出

**目的**：正規表現では捉えられない意味的なリスクを捕捉

**モデル分離**：
- Model A（安全分類器）：独立API、低温度
- Model B（コンテンツ生成）：AがOKのときのみ呼ぶ

**コード**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L4500-L4600)

---

## 第3層：意図分類

**目的**：ユーザーを正しいツールとペルソナに案内

**ツール一覧**：schedule、plan、search、thought_translate、identity、chat

**高速化**：よくあるパターンは正規表現で LLM をスキップして200ms節約

**コード**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L3200-L3450)

---

## 第4層：説明可能な拒否レイヤー

**目的**：拒否を透明化し代替行動を提示

**構成**：
1. 原因タグ（域外/リスク/情報不足）
2. 直接拒否理由
3. 提供可能な代替
4. 不確定要素（タグが間違っていたら知らせて）
5. 次の一手（補足情報/別の問い/目標明示）

**関数**：replaceRobotRefusal → inferRefusalProfile → formatExplainableRefusal

**コード**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L5163-L5215)

---

## 第5層：ガード付きコンテンツ生成

### ガード 1：時間主張のブロック

「明日何の授業？」にデータなしで「あります」と出力しない

### ガード 2：証拠表示

検索回答は必ず出典付き、モデル知識は“古いかも”と明示

### ガード 3：ペルソナ切替

| 条件 | 変更前 | 変更後 | 理由 |
|------|--------|--------|------|
| 判断・計画 | Alice | Professional | 精度が必要 |
| 安全ブロック | Alice | Professional | 権威づけ |
| Web チャネル | Alice | Copilot | 信頼性 |
| QQ チャット | Professional | Alice | 親しみ |

**コード**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L5500-L5650)

---

## データフロー例：「明日何の授業？」

1. 第0層：文脈チェック → 猜疑なし
2. 第1層：正規表現 → 通過
3. 第2層：LLM 安全 → 通過
4. 第3層：意図判定 → schedule
5. 第4層：課表データなし → 拒否レイヤー発動
6. 第5層：ガード付き出力
7. 応答：「課表を送ってください。確定した授業はお答えできません。」

**コード参照**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L6100-L6200)

---

## マルチペルソナシステム

| ペルソナ | 使用場面 | 特徴 |
|----------|----------|------|
| Alice | QQ チャット | 活発、絵文字、キャンパス語彙 |
| Professional | Web/計画 | 簡潔、感情無し、箇条書き |
| Translator | 思考整理 | 表情を抑え、理解に集中 |

**自動切替**：
```javascript
if (isPlanMode || isDecisionTask || isSafetyBlock || isWebChannel) currentPersona = 'professional';
if (isQQChannel && !isPlanMode && !isSafetyBlock) currentPersona = 'alice';
```

---

## サービスモジュール概要

- `hybridSearch.js`: Azure AI Search + DuckDuckGo の複合検索
- `scheduleService.js`: ICS/Excel を解析、Cosmos DB に保存、日付検索
- `visionService.js`: Azure Vision + Llama Vision のデュアルエンジン
- `emotionService.js`: 好感度 → 語気/長さ調整

---

## デプロイと監視

GitHub Repo → GitHub Actions → Azure Functions (Flex) → Cosmos DB / AI Search → Application Insights

スクリプト：`deploy-functions.sh`

---

## 主要指標

| 指標 | 目標 | 意義 |
|------|------|------|
| Safety block rate | 95%以上 | 安全第一 |
| False refusal rate | 5%未満 | 利便性 |
| Explainable refusal coverage | 100% | 信頼性 |
| Schedule hallucination rate | 0% | 重大影響を防ぐ |
| Search citation rate | 100% | 検証可能性 |

---

## 進化ログ

| 日付 | 変更 | 理由 |
|------|------|------|
| 2024-11 | Alice ペルソナ導入 | 人間らしさ追求 |
| 2024-12 | Evidence/Claim 分離 | 誤課表対応 |
| 2024-12 | マルチレイヤ安全 | プロンプトインジェクション対応 |
| 2025-01 | 説明的拒否 | 冷たい拒否を避ける |
| 2025-01 | 明確化レイヤ | "永遠永遠" の検索騒音除去 |
| 2025-01 | Translator モード | QQ ユーザーに思考整理を提供 |

---

## 今後の予定

1. Confidence gating（低信頼度で行動をブロック）
2. Outcome sandbox（危険操作は dry-run）
3. Long-term memory RAG（AI Search にコンテキスト保存）
4. 可視化（どのレイヤが処理したかをユーザーへ）

---

## 参考

- [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md)
- [src/common/safety.js](src/common/safety.js)
- [src/functions/schoolBot.js](src/functions/schoolBot.js)
- [docs/P0-INTEGRATION-GUIDE.md](docs/P0-INTEGRATION-GUIDE.md)

---

*技術文書：Ziheng Liu*  
*プリンシプルがパターンより先にある*
