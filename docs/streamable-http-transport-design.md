# Phase 1: Streamable HTTP Transport (Stateless) + 사용자별 토큰 관리

## Context

현재 freee-mcp 서버는 StdioServerTransport만 지원하여 로컬 CLI에서만 사용 가능.
freee가 K8s에 서버로 호스팅하여, 사용자가 URL 입력만으로 접속 가능하게 한다.

목표:
- Streamable HTTP transport 추가 (Stateless 모드, 기존 stdio와 공존)
- 사용자별 API Key 발급 및 freee OAuth 토큰 관리
- K8s 수평 확장을 고려한 외부 저장소 대응 (Redis)
- 로컬 개발에서는 파일 기반 저장소로 의존성 제로 유지

---

## 설계 결정 사항

### HTTP Framework: Express
- MCP TypeScript SDK 공식 예제에서 사용하는 프레임워크
- 향후 MCP OAuth 2.1 미들웨어(`requireBearerAuth`)도 Express 기반
- 미들웨어 패턴으로 인증, CORS, security headers 확장 용이

### Transport: Streamable HTTP - Stateless 모드
- MCP의 최신 방향성에 맞춰 Stateless 모드 채택
- `sessionIdGenerator: undefined`, `enableJsonResponse: true`
- SSE 불사용 - 순수 HTTP POST → JSON 응답
- K8s 수평 확장에 최적 (sticky session 불필요, 어떤 Pod이 받아도 동일 처리)
- 엔드포인트: `POST /mcp` 1개만 필요 (GET, DELETE 불필요)

### 사용자 인증: API Key 방식
- 사용자가 `/setup` 페이지에서 freee OAuth 인증을 1회 완료
- 서버가 API Key 발급 + freee 토큰 저장
- 사용자는 MCP 설정에 API Key만 입력하면 완료
- 토큰 갱신은 서버가 자동 처리

### 토큰 저장소: TokenStore interface
- `REDIS_URL` 환경변수 유무로 자동 선택
- 로컬 개발: `FileTokenStore` (JSON 파일, 의존성 제로)
- K8s 배포: `RedisTokenStore` (수평 확장 대응)

### Port: 3000 (기본값, 설정 가능)

---

## 사용자 플로우

```
[1회 등록]
1. 사용자가 https://mcp.freee.co.jp/setup 접속
2. "freee 계정으로 연결하기" 클릭
3. freee 로그인 + 권한 동의 (기존 OAuth 코드 재활용)
4. 서버가 토큰 저장 + API Key 생성
5. 화면에 API Key 표시: "sk-xxxxxxxxxxxx"

[MCP 클라이언트 설정 - 1회]
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

[매일 사용 - 자동]
MCP 클라이언트 → POST /mcp + Bearer sk-xxx
                    ↓
               서버가 API Key로 TokenStore에서 freee 토큰 조회
                    ↓
               freee API 호출 (토큰 갱신도 서버가 자동 처리)
                    ↓
               JSON 응답 반환
```

---

## 구현 계획

### Step 1: 의존성 추가

`package.json` 수정:
- dependencies: `express`, `ioredis`
- devDependencies: `@types/express`

`ioredis`는 optional peer dependency로 처리 가능
(REDIS_URL 미설정 시 import하지 않으면 로컬에서 불필요)

### Step 2: TokenStore interface (`src/store/token-store.ts`)

사용자별 토큰 데이터를 관리하는 추상 인터페이스:

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

로컬 개발용 파일 기반 구현:
- `~/.config/freee-mcp/user-tokens.json`에 저장
- 기존 `src/auth/tokens.ts`의 패턴 재활용 (파일 I/O, permission 0600)
- 소수 사용자 환경에서 사용

### Step 4: RedisTokenStore (`src/store/redis-token-store.ts`)

K8s 배포용 Redis 구현:
- `REDIS_URL` 환경변수로 접속 정보 설정
- key 형식: `freee-mcp:token:{apiKey}`
- TTL: refresh_token 유효기간에 맞춰 자동 만료
- ioredis 사용 (reconnect, cluster 지원)

### Step 5: TokenStore 팩토리 (`src/store/index.ts`)

환경에 따라 자동 선택:

```typescript
export function createTokenStore(): TokenStore {
  if (process.env.REDIS_URL) {
    return new RedisTokenStore(process.env.REDIS_URL);
  }
  return new FileTokenStore();
}
```

### Step 6: API Key 관리 (`src/auth/api-keys.ts`)

- `generateApiKey()`: `crypto.randomBytes(32)` 기반 "sk-" 접두사 키 생성
- API Key를 TokenStore를 통해 검증
- 기존 `src/auth/tokens.ts`의 `refreshAccessToken()` 재활용하여 토큰 갱신

### Step 7: CLI 인자 파싱 확장 (`src/index.ts`)

```
freee-mcp                      # stdio 모드 (기본값, 기존 동작 유지)
freee-mcp --transport http     # HTTP 모드
freee-mcp --port 8080          # HTTP 포트 지정 (기본: 3000)
freee-mcp configure            # 기존 설정 위자드
```

- `--transport` 옵션 파싱 (`stdio` | `http`, 기본값: `stdio`)
- `--port` 옵션 파싱 (기본값: 3000)
- transport 선택에 따라 `createAndStartServer()` 또는 `createAndStartHttpServer()` 호출

### Step 8: Config 확장 (`src/config.ts`, `src/constants.ts`)

`src/constants.ts`에 HTTP 관련 상수 추가:
- `DEFAULT_HTTP_PORT = 3000`
- `DEFAULT_HTTP_HOST = '0.0.0.0'`
- `MCP_ENDPOINT_PATH = '/mcp'`

`src/config.ts`의 `Config` interface에 http 설정 추가:
```typescript
http: {
  port: number;
  host: string;
}
```

### Step 9: MCP Server 팩토리 분리 (`src/mcp/handlers.ts`)

현재 `createAndStartServer()`를 분리:

- `createMcpServer(): McpServer` - 서버 인스턴스 생성 + 도구 등록
- `createAndStartServer()` - 기존 stdio 모드 (변경 없음)
- `createAndStartHttpServer(options)` - 새로운 HTTP 모드

### Step 10: 사용자별 토큰 해결 (`src/api/client.ts` 수정)

HTTP 모드에서 요청별 사용자 토큰으로 freee API를 호출하도록:

- `makeApiRequest()`에 optional `accessToken` 파라미터 추가
- 기존 stdio 모드: 파라미터 없이 호출 → 기존 `getValidAccessToken()` 사용 (변경 없음)
- HTTP 모드: API Key에서 조회한 토큰을 직접 전달

### Step 11: HTTP 서버 구현 (`src/server/http.ts`)

Express 기반 Stateless HTTP 서버:

1. Express app + 미들웨어:
   - `express.json()` body parser
   - CORS 헤더
   - Security headers (X-Content-Type-Options, X-Frame-Options)

2. MCP 라우트 (Stateless - POST만):
   - `POST /mcp` - 모든 MCP 요청 처리
   - 요청마다 새 `StreamableHTTPServerTransport` 생성 (stateless)
   - API Key 검증 → TokenStore에서 토큰 조회 → MCP 요청 처리

3. Setup 라우트 (인증 불필요):
   - `GET /setup` - OAuth 등록 페이지 (간단한 HTML)
   - `GET /setup/auth` - freee OAuth 시작 (기존 코드 재활용)
   - `GET /setup/callback` - OAuth 콜백 → 토큰 저장 + API Key 발급

4. 헬스 체크:
   - `GET /health` - K8s liveness/readiness probe용

5. Graceful shutdown:
   - SIGINT/SIGTERM에서 server.close() + Redis 연결 정리

Stateless POST /mcp 핸들러 흐름:
```
1. Authorization 헤더에서 API Key 추출
2. TokenStore에서 사용자 토큰 조회 (없으면 401)
3. 토큰 만료 확인 → 필요 시 refresh → TokenStore 업데이트
4. 새 StreamableHTTPServerTransport 생성 (stateless)
5. 새 McpServer 인스턴스 생성 + 도구 등록 (사용자 토큰 바인딩)
6. server.connect(transport)
7. transport.handleRequest(req, res, req.body)
8. JSON 응답 반환
```

### Step 12: Setup 페이지 (`src/server/setup.ts`)

OAuth 등록 플로우:

- `GET /setup` → 간단한 HTML 페이지 (inline, 별도 파일 불필요)
- `GET /setup/auth` → freee OAuth URL로 리다이렉트
  - 기존 `generatePKCE()`, `buildAuthUrl()` 재활용 (`src/auth/oauth.ts`)
  - redirect_uri를 서버 URL로 설정 (`/setup/callback`)
  - state에 PKCE verifier를 임시 저장 (in-memory Map, 5분 TTL)
- `GET /setup/callback` → OAuth 코드 수신
  - 기존 `exchangeCodeForTokens()` 재활용 (`src/auth/oauth.ts`)
  - API Key 생성 + TokenStore에 저장
  - 사용자에게 API Key 표시하는 HTML 반환

### Step 13: 테스트

- `src/store/file-token-store.test.ts` - 파일 저장소 단위 테스트
- `src/store/redis-token-store.test.ts` - Redis 저장소 테스트 (mock)
- `src/auth/api-keys.test.ts` - API Key 생성/검증 테스트
- `src/server/http.test.ts` - HTTP 서버 통합 테스트
  - POST /mcp 응답
  - API Key 검증 (유효/무효)
  - Stateless 동작 확인 (세션 헤더 없음)
- `src/server/setup.test.ts` - Setup 플로우 테스트

---

## 수정 대상 파일 정리

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `package.json` | 수정 | express, ioredis, @types/express 추가 |
| `src/index.ts` | 수정 | CLI 인자 파싱 확장 (--transport, --port) |
| `src/constants.ts` | 수정 | HTTP 관련 상수 추가 |
| `src/config.ts` | 수정 | Config interface에 http 설정 추가 |
| `src/mcp/handlers.ts` | 수정 | MCP 서버 팩토리 분리 + HTTP 서버 시작 함수 |
| `src/api/client.ts` | 수정 | makeApiRequest에 optional accessToken 파라미터 |
| `src/store/token-store.ts` | 신규 | TokenStore interface + UserTokenData 정의 |
| `src/store/file-token-store.ts` | 신규 | 파일 기반 TokenStore 구현 |
| `src/store/redis-token-store.ts` | 신규 | Redis 기반 TokenStore 구현 |
| `src/store/index.ts` | 신규 | TokenStore 팩토리 |
| `src/auth/api-keys.ts` | 신규 | API Key 생성/검증 |
| `src/server/http.ts` | 신규 | Express HTTP 서버 (Stateless MCP + Setup 라우트) |
| `src/server/setup.ts` | 신규 | OAuth 등록 플로우 + Setup 페이지 |
| `src/store/*.test.ts` | 신규 | TokenStore 테스트 |
| `src/auth/api-keys.test.ts` | 신규 | API Key 테스트 |
| `src/server/*.test.ts` | 신규 | HTTP 서버 + Setup 테스트 |

---

## 기존 코드 재활용 목록

| 기존 코드 | 파일 | 재활용 방법 |
|----------|------|------------|
| `generatePKCE()` | `src/auth/oauth.ts` | Setup OAuth 플로우에서 그대로 사용 |
| `buildAuthUrl()` | `src/auth/oauth.ts` | redirect_uri만 변경하여 사용 |
| `exchangeCodeForTokens()` | `src/auth/oauth.ts` | Setup callback에서 토큰 교환 |
| `refreshAccessToken()` | `src/auth/tokens.ts` | 토큰 갱신 로직 재활용 (저장 부분만 TokenStore로 변경) |
| `CONFIG_FILE_PERMISSION` | `src/constants.ts` | FileTokenStore에서 재활용 |
| `TokenData` / `TokenDataSchema` | `src/auth/tokens.ts` | UserTokenData의 기반 |

---

## Verification

### 빌드 및 정적 검사
```bash
pnpm typecheck && pnpm lint && pnpm test:run && pnpm build
```

### stdio 모드 회귀 확인 (기존 동작 유지)
```bash
pnpm start                    # stdio 모드로 정상 기동 확인
pnpm inspector                # MCP inspector로 도구 호출 테스트
```

### HTTP 모드 기본 동작
```bash
# 서버 기동 (로컬, FileTokenStore)
pnpm start -- --transport http --port 3000

# 헬스 체크
curl http://localhost:3000/health
# → 200 OK

# MCP 요청 (API Key 없이 → 401)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# → 401 Unauthorized

# Setup 페이지 접속
open http://localhost:3000/setup
# → freee OAuth 인증 → API Key 발급

# API Key로 MCP initialize
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer sk-발급받은키" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# → 200 OK + JSON InitializeResult (SSE 아님)
```

### Redis 연동 확인 (K8s 환경 시뮬레이션)
```bash
# Redis 로컬 기동 (Docker)
docker run -d -p 6379:6379 redis

# Redis 모드로 서버 기동
REDIS_URL=redis://localhost:6379 pnpm start -- --transport http

# Setup + API 호출 테스트 (위와 동일)
```
