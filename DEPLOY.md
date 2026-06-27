# デプロイ手順（Render・ターミナル不要）

ブラウザ操作だけで、常時稼働・固定URLの本番環境を作ります。所要 約15分・無料。

アップロードするファイルは `ai-diagnosis-deploy.zip` に入っています。
**まずこのZIPをダブルクリックして解凍**してください（中に7つのファイルが入っています）。

---

## ステップ1：GitHubアカウントを作る（無料・5分）

1. https://github.com/signup を開く
2. メールアドレス・パスワード・ユーザー名を入力して登録
3. メール認証を済ませる

## ステップ2：コードを置くリポジトリを作る

1. 右上の「＋」→ **New repository**
2. **Repository name** に `ai-diagnosis` と入力
3. **Public** を選択（無料のRender連携が簡単になります）
4. **Create repository** をクリック

## ステップ3：ファイルをアップロード（ドラッグ&ドロップ）

1. 作成したリポジトリ画面の **「uploading an existing file」** リンクをクリック
   （または「Add file」→「Upload files」）
2. 解凍してできた **7つのファイルすべて** をドラッグ＆ドロップ
   - `server.py` / `app.js` / `index.html` / `styles.css`
   - `render.yaml` / `requirements.txt` / `README.md`
3. 下の **Commit changes** をクリック

> ⚠️ フォルダごとではなく「中のファイル7つ」をアップロードしてください。
> `render.yaml` がリポジトリの一番上の階層にあることが重要です。

## ステップ4：Renderでデプロイ

1. https://render.com を開き、**Get Started**
2. **「Sign in with GitHub」** を選び、GitHubで認証（Authorize）
3. ダッシュボードで **「New +」→「Blueprint」**
4. 先ほどの `ai-diagnosis` リポジトリを選んで **Connect**
5. Renderが `render.yaml` を自動で読み込みます。**Apply / Create** をクリック
6. ビルド＆デプロイが始まります（数分）。完了すると公開URLが表示されます
   例：`https://ai-diagnosis-xxxx.onrender.com`

## ステップ5：動作確認

- 公開URLを開く → 管理画面が表示され、サンプル診断が入っています
- 診断URL：`https://ai-diagnosis-xxxx.onrender.com/#/d/diet-30?source=line`
- 管理画面の「編集」で **予約URLを実際のURLに変更** してください

---

## 知っておくべきこと（無料プランの仕様）

- **コールドスタート**：15分アクセスが無いとスリープし、次のアクセスで起動に
  数十秒かかります（その後は快適）。LINE配信直前に一度開いておくと安心。
- **データの永続性**：無料プランはディスクが揮発するため、再デプロイやスリープ復帰の
  タイミングで **回答データ・作成した診断がリセットされる場合があります**
  （サンプル診断は毎回自動で復活します）。
  → 回答データを確実に残したい場合は、Renderの有料プラン＋永続ディスク
  （`render.yaml` のコメント部分を有効化）か、外部データベースへの移行が必要です。
  必要になったら対応します。

## 更新方法（コードを直したとき）

GitHubのリポジトリで該当ファイルを再アップロード（上書きコミット）すると、
Renderが自動で再デプロイします。
