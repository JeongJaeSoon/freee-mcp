# Phase 1: Streamable HTTP Transport (Stateless) + ユーザー別トークン管理

## Context

現在、freee-mcp サーバーは StdioServerTransport のみ対応しており、ローカル CLI でしか使用できない。
freee が K8s にサーバーとしてホスティングし、ユーザーが URL 入力のみで接続可能にする。

目標:
- Streamable HTTP transport の追加 (Stateless モード、既存 stdio と共存)
- ユーザー別 API Key 発行および freee OAuth トークン管理
- K8s 水平スケーリングを考慮した外部ストレージ対応 (Redis)
- ローカル開発ではファイルベースストレージで依存性ゼロを維持

---

## 設計決定事項

### HTTP Framework: Express
- MCP TypeScript SDK 公式サンプルで使用されているフレームワーク
- 今後の MCP OAuth 2.1 ミドルウェア(`requireBearerAuth`)も Express ベース
- ミドルウェアパターンにより認証、CORS、security headers の拡張が容易

### Transport: Streamable HTTP - Stateless モード
- MCP の最新方向性に合わせて Stateless モードを採用
- `sessionIdGenerator: undefined`, `enableJsonResponse: true`
- SSE 不使用 - 純粋な HTTP POST → JSON レスポンス
- K8s 水平スケーリングに最適 (sticky session 不要、どの Pod が受けても同一処理)
- エンドポイント: `POST /mcp` 1つのみ必要 (GET, DELETE 不要)

### ユーザー認証: API Key 方式
- ユーザーが `/setup` ページで freee OAuth 認証を1回完了
- サーバーが API Key 発行 + freee トークン保存
- ユーザーは MCP 設定に API Key を入力するだけで完了
- トークン更新はサーバーが自動処理

### トークンストア: TokenStore interface
- `REDIS_URL` 環境変数の有無で自動選択
- ローカル開発: `FileTokenStore` (JSON ファイル、依存性ゼロ)
- K8s デプロイ: `RedisTokenStore` (水平スケーリング対応)

### Port: 3000 (デフォルト、設定可能)

---

## ユーザーフロー

```
[1回限りの登録]
1. ユーザーが https://mcp.freee.co.jp/setup にアクセス
2. 「freee アカウントで連携する」をクリック
3. freee ログイン + 権限同意 (既存 OAuth コード再利用)
4. サーバーがトークン保存 + API Key 生成
5. 画面に API Key 表示: "sk-xxxxxxxxxxxx"

[MCP クライアント設定 - 1回]
{
  "mcpServers": {
    "freee": {
      "url": "https://mcp.freee.co.jp/mcp",
      "headers": {
        "Authorization": "Bearer sk-xxxxxxxxxxxx"
      }
    }
  }
}

[日常利用 - 自動]
MCP クライアント → POST /mcp + Bearer sk-xxx
                    ↓
               サーバーが API Key で TokenStore から freee トークンを取得
                    ↓
               freee API 呼び出し (トークン更新もサーバーが自動処理)
                    ↓
               JSON レスポンス返却
```

---

## 実装計画

### Step 1: 依存関係の追加

`package.json` の修正:
- dependencies: `express`, `ioredis`
- devDependencies: `@types/express`

`ioredis` は optional peer dependency として処理可能
(REDIS_URL 未設定時に import しなければローカルでは不要)

### Step 2: TokenStore interface (`src/store/token-store.ts`)

ユーザー別トークンデータを管理する抽象インターフェース:

```typescript
interface UserTokenData {
  apiKey: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  companyId: string;
  userId?: string;
  createdAt: number;
}

interface TokenStore {
  save(apiKey: string, data: UserTokenData): Promise<void>;
  load(apiKey: string): Promise<UserTokenData | null>;
  delete(apiKey: string): Promise<void>;
  exists(apiKey: string): Promise<boolean>;
}
```

### Step 3: FileTokenStore (`src/store/file-token-store.ts`)

ローカル開発用ファイルベース実装:
- `~/.config/freee-mcp/user-tokens.json` に保存
- 既存 `src/auth/tokens.ts` のパターンを再利用 (ファイル I/O, permission 0600)
- 少数ユーザー環境で使用

### Step 4: RedisTokenStore (`src/store/redis-token-store.ts`)

K8s デプロイ用 Redis 実装:
- `REDIS_URL` 環境変数で接続情報を設定
- key 形式: `freee-mcp:token:{apiKey}`
- TTL: refresh_token の有効期間に合わせて自動失効
- ioredis 使用 (reconnect, cluster 対応)

### Step 5: TokenStore ファクトリ (`src/store/index.ts`)

環境に応じて自動選択:

```typescript
export function createTokenStore(): TokenStore {
  if (process.env.REDIS_URL) {
    return new RedisTokenStore(process.env.REDIS_URL);
  }
  return new FileTokenStore();
}
```

### Step 6: API Key 管理 (`src/auth/api-keys.ts`)

- `generateApiKey()`: `crypto.randomBytes(32)` ベースの "sk-" プレフィックス付きキー生成
- API Key を TokenStore を通じて検証
- 既存 `src/auth/tokens.ts` の `refreshAccessToken()` を再利用してトークン更新

### Step 7: CLI 引数パーシング拡張 (`src/index.ts`)

```
freee-mcp                      # stdio モード (デフォルト、既存動作維持)
freee-mcp --transport http     # HTTP モード
freee-mcp --port 8080          # HTTP ポート指定 (デフォルト: 3000)
freee-mcp configure            # 既存設定ウィザード
```

- `--transport` オプションのパーシング (`stdio` | `http`, デフォルト: `stdio`)
- `--port` オプションのパーシング (デフォルト: 3000)
- transport 選択に応じて `createAndStartServer()` または `createAndStartHttpServer()` を呼び出し

### Step 8: Config 拡張 (`src/config.ts`, `src/constants.ts`)

`src/constants.ts` に HTTP 関連定数を追加:
- `DEFAULT_HTTP_PORT = 3000`
- `DEFAULT_HTTP_HOST = '0.0.0.0'`
- `MCP_ENDPOINT_PATH = '/mcp'`

`src/config.ts` の `Config` interface に http 設定を追加:
```typescript
http: {
  port: number;
  host: string;
}
```

### Step 9: MCP Server ファクトリの分離 (`src/mcp/handlers.ts`)

現在の `createAndStartServer()` を分離:

- `createMcpServer(): McpServer` - サーバーインスタンス生成 + ツール登録
- `createAndStartServer()` - 既存 stdio モード (変更なし)
- `createAndStartHttpServer(options)` - 新規 HTTP モード

### Step 10: ユーザー別トークン解決 (`src/api/client.ts` 修正)

HTTP モードでリクエスト別にユーザートークンで freee API を呼び出すように:

- `makeApiRequest()` に optional `accessToken` パラメータを追加
- 既存 stdio モード: パラメータなしで呼び出し → 既存 `getValidAccessToken()` 使用 (変更なし)
- HTTP モード: API Key から取得したトークンを直接渡す

### Step 11: HTTP サーバー実装 (`src/server/http.ts`)

Express ベースの Stateless HTTP サーバー:

1. Express app + ミドルウェア:
   - `express.json()` body parser
   - CORS ヘッダー
   - Security headers (X-Content-Type-Options, X-Frame-Options)

2. MCP ルート (Stateless - POST のみ):
   - `POST /mcp` - 全 MCP リクエストを処理
   - リクエストごとに新しい `StreamableHTTPServerTransport` を生成 (stateless)
   - API Key 検証 → TokenStore からトークン取得 → MCP リクエスト処理

3. Setup ルート (認証不要):
   - `GET /setup` - OAuth 登録ページ (シンプルな HTML)
   - `GET /setup/auth` - freee OAuth 開始 (既存コード再利用)
   - `GET /setup/callback` - OAuth コールバック → トークン保存 + API Key 発行

4. ヘルスチェック:
   - `GET /health` - K8s liveness/readiness probe 用

5. Graceful shutdown:
   - SIGINT/SIGTERM で server.close() + Redis 接続のクリーンアップ

Stateless POST /mcp ハンドラーの流れ:
```
1. Authorization ヘッダーから API Key を抽出
2. TokenStore からユーザートークンを取得 (なければ 401)
3. トークン期限切れ確認 → 必要に応じて refresh → TokenStore 更新
4. 新しい StreamableHTTPServerTransport を生成 (stateless)
5. 新しい McpServer インスタンス生成 + ツール登録 (ユーザートークンをバインド)
6. server.connect(transport)
7. transport.handleRequest(req, res, req.body)
8. JSON レスポンス返却
```

### Step 12: Setup ページ (`src/server/setup.ts`)

OAuth 登録フロー:

- `GET /setup` → シンプルな HTML ページ (inline、別ファイル不要)
- `GET /setup/auth` → freee OAuth URL にリダイレクト
  - 既存 `generatePKCE()`, `buildAuthUrl()` を再利用 (`src/auth/oauth.ts`)
  - redirect_uri をサーバー URL に設定 (`/setup/callback`)
  - state に PKCE verifier を一時保存 (in-memory Map, 5分 TTL)
- `GET /setup/callback` → OAuth コード受信
  - 既存 `exchangeCodeForTokens()` を再利用 (`src/auth/oauth.ts`)
  - API Key 生成 + TokenStore に保存
  - ユーザーに API Key を表示する HTML を返却

### Step 13: テスト

- `src/store/file-token-store.test.ts` - ファイルストア単体テスト
- `src/store/redis-token-store.test.ts` - Redis ストアテスト (mock)
- `src/auth/api-keys.test.ts` - API Key 生成/検証テスト
- `src/server/http.test.ts` - HTTP サーバー統合テスト
  - POST /mcp レスポンス
  - API Key 検証 (有効/無効)
  - Stateless 動作確認 (セッションヘッダーなし)
- `src/server/setup.test.ts` - Setup フローテスト

---

## 修正対象ファイル一覧

| ファイル | 変更種別 | 説明 |
|---------|----------|------|
| `package.json` | 修正 | express, ioredis, @types/express 追加 |
| `src/index.ts` | 修正 | CLI 引数パーシング拡張 (--transport, --port) |
| `src/constants.ts` | 修正 | HTTP 関連定数追加 |
| `src/config.ts` | 修正 | Config interface に http 設定追加 |
| `src/mcp/handlers.ts` | 修正 | MCP サーバーファクトリ分離 + HTTP サーバー起動関数 |
| `src/api/client.ts` | 修正 | makeApiRequest に optional accessToken パラメータ |
| `src/store/token-store.ts` | 新規 | TokenStore interface + UserTokenData 定義 |
| `src/store/file-token-store.ts` | 新規 | ファイルベース TokenStore 実装 |
| `src/store/redis-token-store.ts` | 新規 | Redis ベース TokenStore 実装 |
| `src/store/index.ts` | 新規 | TokenStore ファクトリ |
| `src/auth/api-keys.ts` | 新規 | API Key 生成/検証 |
| `src/server/http.ts` | 新規 | Express HTTP サーバー (Stateless MCP + Setup ルート) |
| `src/server/setup.ts` | 新規 | OAuth 登録フロー + Setup ページ |
| `src/store/*.test.ts` | 新規 | TokenStore テスト |
| `src/auth/api-keys.test.ts` | 新規 | API Key テスト |
| `src/server/*.test.ts` | 新規 | HTTP サーバー + Setup テスト |

---

## 既存コード再利用一覧

| 既存コード | ファイル | 再利用方法 |
|-----------|---------|-----------|
| `generatePKCE()` | `src/auth/oauth.ts` | Setup OAuth フローでそのまま使用 |
| `buildAuthUrl()` | `src/auth/oauth.ts` | redirect_uri のみ変更して使用 |
| `exchangeCodeForTokens()` | `src/auth/oauth.ts` | Setup callback でトークン交換 |
| `refreshAccessToken()` | `src/auth/tokens.ts` | トークン更新ロジックを再利用 (保存部分のみ TokenStore に変更) |
| `CONFIG_FILE_PERMISSION` | `src/constants.ts` | FileTokenStore で再利用 |
| `TokenData` / `TokenDataSchema` | `src/auth/tokens.ts` | UserTokenData のベース |

---

## Verification

### ビルドおよび静的検査
```bash
pnpm typecheck && pnpm lint && pnpm test:run && pnpm build
```

### stdio モード回帰確認 (既存動作維持)
```bash
pnpm start                    # stdio モードで正常起動を確認
pnpm inspector                # MCP inspector でツール呼び出しテスト
```

### HTTP モード基本動作
```bash
# サーバー起動 (ローカル、FileTokenStore)
pnpm start -- --transport http --port 3000

# ヘルスチェック
curl http://localhost:3000/health
# → 200 OK

# MCP リクエスト (API Key なし → 401)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# → 401 Unauthorized

# Setup ページアクセス
open http://localhost:3000/setup
# → freee OAuth 認証 → API Key 発行

# API Key で MCP initialize
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer sk-発行されたキー" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# → 200 OK + JSON InitializeResult (SSE ではない)
```

### Redis 連携確認 (K8s 環境シミュレーション)
```bash
# Redis ローカル起動 (Docker)
docker run -d -p 6379:6379 redis

# Redis モードでサーバー起動
REDIS_URL=redis://localhost:6379 pnpm start -- --transport http

# Setup + API 呼び出しテスト (上記と同様)
```
