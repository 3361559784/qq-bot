> **Languages**: [English](README.md) | [中文](README.zh.md) | [日本語](README.jp.md) | [Русский](README.ru.md)

# Alice / Campus Copilot

安全第一のキャンパスAIアシスタントで、**幻覚や誤誘導、責任の漂流を防ぐ**ことを目的としています。

> 💡 このプロジェクトがなぜ存在するのかその設計の旅を知りたい方は [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) を参照してください。  
> 🏗️ 技術的なアーキテクチャやシステム実装については [ARCHITECTURE.md](ARCHITECTURE.md) をご覧ください。

---

## このプロジェクトは何を解決するのか？

ほとんどのキャンパスチャットボットは次を最適化します：
- 自然な会話
- ペルソナの継続性
- エンゲージメント

このプロジェクトが最適化するのは：
- ❗ **スケジュールの幻覚を出さない**（授業時間を捏造しない）
- ❗ **責任の誤帰属をしない**（誰が何を判断しているか明確に）
- ❗ **拒否できるタイミングを理解し、理由を説明する**

---

## コアデザイン原則

| 原則 | 意味 |
|------|------|
| **Evidence > Fluency** | 滑らかな言葉ではなく、データソースを示す |
| **拒否は説明可能であるべき** | 「ノー」には必ず理由を添える |
| **判断は人間のもの** | AIは支援し、人間が決定する |
| **感情依存を起点にしない** | 付き合い ≠ コア責任 |

---

## 主な特徴

✅ **マルチレイヤー安全ルーティング**  
- 決定的ルール + LLM セーフティチェック + 意図分類

✅ **説明的拒否レイヤー**  
- 拒否には理由タグ、代替支援、次のステップを含む

✅ **検索の前に文脈を明確化**  
- 曖昧な入力？まず尋ね、それから検索を決定

✅ **デュアルインタラクションモード**  
- QQ：Alice ペルソナ（活発で文化に寄り添う）  
- Web：Copilot モード（プロフェッショナルで簡潔）

✅ **重要操作は手動確認付き**  
- 自律ループ禁止；人の承認が必要

---

## 使ってはいけない場面

❌ 感情的なコンパニオンAIを望む場合  
❌ 自自治のエージェントを求める場合  
❌ “人間らしさ”を正確性より重視する場合  
❌ 24時間無制限の自由なチャットが必要な場合

---

## 技術スタック

| レイヤー | 技術 |
|----------|------|
| バックエンド | Azure Functions（Node.js 20+） |
| フロントエンド | Next.js 14 + TypeScript |
| データベース | Azure Cosmos DB（NoSQL） |
| 検索 | Azure AI Search + DuckDuckGo |
| ビジョン | Azure Computer Vision + Llama Vision |
| 監視 | Application Insights |

---

## クイックスタート

### 前提条件
- Node.js 20+
- Azure Functions Core Tools 4.x
- Azure サブスクリプション（Cosmos DB、Functions、AI Search 用）

### ローカル開発

```bash
# 1. 依存関係のインストール
npm install

# 2. 環境変数の設定
cp local.settings.json.example local.settings.json
# local.settings.json を編集し、API キーを設定

# 3. バックエンド起動（Azure Functions）
func host start

# 4. フロントエンド起動（オプション、Web UI）
cd campus-ai-web && npm run dev
```

### Azure へのデプロイ

```bash
# 方法①：デプロイスクリプトを使用
./deploy-functions.sh

# 方法②：main ブランチに push（GitHub Actions をトリガー）
git push origin main
```

---

## プロジェクト構成

```
qq-bot-aris-clean/
├── src/
│   ├── functions/
│   │   ├── schoolBot.js        # メインロジック（7000+ 行の進化史）
│   │   └── dailyClassReminder.js
│   └── common/
│       └── safety.js           # 決定的安全ルール
├── services/                   # モジュール化されたサービス
│   ├── hybridSearch.js
│   ├── scheduleService.js
│   └── visionService.js
├── campus-ai-web/              # Next.js フロントエンド
├── docs/                       # デザイン進化ドキュメント
└── .github/workflows/          # CI/CD パイプライン
```

---

## ドキュメント一覧

| ドキュメント | 目的 |
|--------------|------|
| [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) | プロジェクトの存在理由とデザイン哲学、信念 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 技術的アーキテクチャと多層安全システム |
| [docs/P0-INTEGRATION-GUIDE.md](docs/P0-INTEGRATION-GUIDE.md) | 本番デプロイ統合ガイド |

---

## コントリビュート

このプロジェクトは**学習記録**であり**責任実験**でもあります。貢献は歓迎しますが、まず [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) を読んで核心原則を理解してください。

---

## ライセンス

Apache License 2.0 (Apache-2.0)。`LICENSE` と `NOTICE` を参照してください。

---

## 謝辞

Alice の“偽スケジュール”に騙された皆さん、ありがとう。あなたたちのおかげで**「かわいさ」は免罪符ではない**と気づきました。

AI システムを作るすべての人へ：
「どう賢くするか」ではなく**「賢くないときに何の害があるか」**を問ってください。

---

*Ziheng Liu による制作*  
*「彼女をより人間らしく」から「システムをより害を少なく」への記録*
