<h1 align="center">OpenMeet</h1>

<p align="center">
  <strong>Self-hosted video meetings that run entirely in the browser.</strong><br>
  Create a room, share the link, and people join by clicking it — no app, no plugin, no account for guests.
</p>

<p align="center">
  <a href="#english">English</a> ·
  <a href="#日本語">日本語</a> ·
  <a href="#简体中文">简体中文</a>
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-15-black.svg">
  <img alt="LiveKit" src="https://img.shields.io/badge/LiveKit-SFU-1f8cf9.svg">
  <img alt="tests" src="https://img.shields.io/badge/tests-877%20passing-brightgreen.svg">
</p>

---

## Features

| | |
|---|---|
| 🎥 **Browser-only** | Guests click a link and they are in. Nothing to install, no account required. |
| 🌫️ **Background blur & virtual backgrounds** | Two blur strengths, four bundled backgrounds, or upload your own (stored in-browser, never uploaded to the server). Runs client-side — **zero server cost**. |
| 💬 **In-meeting chat** | Session-scoped; messages are never written to the database. |
| 🔇 **Host controls** | Mute a single participant or everyone, end the meeting, edit/delete rooms. Enforced server-side, not by the client. |
| 📱 **Mobile-first meeting room** | Portrait layouts (full-screen / split / 2×2 / paging), draggable picture-in-picture, safe-area aware, iOS Safari toolbar handled. |
| 🌏 **Japanese / Chinese UI** | Manual switcher with persistence, browser-language auto-detection. |
| 🚦 **Capacity guard** | Global concurrent-participant ceiling sized to your uplink, enforced at room creation and join. |
| 🇨🇳 **Works from mainland China** | No Google Fonts, no GA, no reCAPTCHA; MediaPipe assets are self-hosted; the browser never talks to Supabase directly. |
| 🔌 **Swappable media backend** | All WebRTC lives behind a `MediaProvider` interface — replacing LiveKit with another SFU requires zero UI changes. |

**Stack** — Next.js 15 (App Router) · React 19 · TypeScript · LiveKit · Supabase (Postgres + Auth) · HeroUI + Tailwind · Zustand · Vitest

---

## English

### Requirements

- **Node.js 22+** (the `nanoid` v6 dependency is ESM-only and requires it)
- A **Supabase** project — [cloud](https://supabase.com) or [self-hosted](https://supabase.com/docs/guides/self-hosting)
- A **LiveKit** server — [self-hosted](https://docs.livekit.io/home/self-hosting/deployment/) or [LiveKit Cloud](https://cloud.livekit.io)

### Quick start

```bash
git clone https://github.com/Sanlitukokusai/openmeet.git
cd openmeet
npm install                 # also fetches the MediaPipe assets for background effects
cp .env.example .env.local  # then fill in the values below
npm run dev                 # http://localhost:3000
```

Apply the database migrations (in order) to your Supabase project — via the SQL editor, `psql`, or the Supabase CLI:

```
supabase/migrations/0001_meet_schema.sql   # tables, RLS policies, triggers
supabase/migrations/0002_rate_limit.sql    # password brute-force throttling
supabase/migrations/0003_grants.sql        # service_role only; anon gets nothing
supabase/migrations/0004_meetings_unique_open.sql
```

> **Self-hosted Supabase:** PostgREST must expose the `meet` schema. Checking the box in Studio is not enough if the role config overrides it — run:
> ```sql
> alter role authenticator set pgrst.db_schemas = 'public, graphql_public, meet';
> notify pgrst, 'reload config';
> ```

### Configuration

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase URL |
| `SUPABASE_ANON_KEY` | **No `NEXT_PUBLIC_` prefix on purpose** — the browser never calls Supabase; this is used server-side only |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side only. Never expose it |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Generate with `docker run --rm livekit/generate` |
| `NEXT_PUBLIC_LIVEKIT_URL` | e.g. `wss://livekit.example.com` |
| `APP_DOMAIN` | Used to build invite links. If empty, the app falls back to the forwarded host — correct behind a reverse proxy, but set it explicitly in production |
| `MAX_CONCURRENT_PARTICIPANTS` | Global ceiling across all rooms (default `20`). Size it to your media server's uplink |

### Deploying

**1. LiveKit.** Any deployment method from the [official guide](https://docs.livekit.io/home/self-hosting/deployment/) works. Minimal single-node config:

```yaml
port: 7880
rtc:
  udp_port: 7882          # single UDP mux port — no need to open a 50000-60000 range
  tcp_port: 7881          # TCP fallback for restrictive networks
  use_external_ip: true
keys:
  <YOUR_API_KEY>: <YOUR_API_SECRET>
room:
  max_participants: 50
  empty_timeout: 300
  enable_remote_unmute: true   # required for the host "unmute" action
webhook:
  api_key: <YOUR_API_KEY>
  urls:
    - https://<your-app-domain>/api/webhooks/livekit
```

Put TLS in front of port 7880 (Caddy, nginx, or your platform's ingress) so the browser can reach it over `wss://`.

> **If your platform assigns NodePorts** (Kubernetes-style hosting), set `udp_port`/`tcp_port` to numbers *inside* the NodePort range so the container port and the external port match 1:1. LiveKit advertises the port it listens on — if they differ, ICE never connects.

**2. The app.** It is a standard Next.js server app — deploy it anywhere that runs Node (Vercel, Docker, a VPS, any PaaS):

```bash
npm run build && npm start
```

**3. Point the webhook** at `https://<your-app-domain>/api/webhooks/livekit` and restart LiveKit. Without it, participant join/leave auditing and peak-participant tracking stay empty.

### Architecture notes

- **The browser never talks to Supabase directly.** Every read and write goes through this app's `/api/*` routes with the service role key server-side. Besides being safer, it means the only domain a participant's browser contacts is yours — which is what makes the app usable from networks where `*.supabase.co` is slow or blocked.
- **`MediaProvider` abstraction.** `livekit-client` may only be imported under `lib/media/providers/livekit/` (enforced by ESLint *and* a CI script). Everything else depends on the interface in `lib/media/types.ts`. Swapping in a different SFU means writing one new provider — pages, components and stores stay untouched.
- **Background effects are self-hosted.** `@livekit/track-processors` loads its wasm from jsdelivr and its segmentation model from `storage.googleapis.com` by default. Both are unreachable from mainland China, so the app always points at locally served copies (`npm run setup:assets` fetches them; a regression test pins the paths so nobody can accidentally revert to the CDN).
- **Security posture.** Room passwords are bcrypt-hashed and `password_hash` never leaves the server; per-IP × per-room join throttling (10 attempts / 10 min); participant limits enforced at token issuance; access tokens capped at the room's remaining lifetime (max 6 h); other people's rooms and non-existent rooms return an identical 404 so existence can't be probed.

### Contributing

Issues and pull requests are welcome. Before opening a PR:

```bash
npm test          # 877 tests
npm run lint
npm run build
bash scripts/check-china-safe.sh   # blocks CDN-blocked deps & layering violations
```

### License

MIT — see [LICENSE](LICENSE).

---

## 日本語

### 必要環境

- **Node.js 22 以上**（依存する `nanoid` v6 が ESM 専用のため）
- **Supabase** プロジェクト（[クラウド](https://supabase.com) / [セルフホスト](https://supabase.com/docs/guides/self-hosting)）
- **LiveKit** サーバー（[セルフホスト](https://docs.livekit.io/home/self-hosting/deployment/) / [LiveKit Cloud](https://cloud.livekit.io)）

### クイックスタート

```bash
git clone https://github.com/Sanlitukokusai/openmeet.git
cd openmeet
npm install                 # 背景効果用の MediaPipe 資産も自動取得します
cp .env.example .env.local  # 下表の値を記入
npm run dev                 # http://localhost:3000
```

データベースのマイグレーションを順番に適用してください（Supabase の SQL エディタ / `psql` / Supabase CLI のいずれでも可）：

```
supabase/migrations/0001_meet_schema.sql   # テーブル・RLS ポリシー・トリガー
supabase/migrations/0002_rate_limit.sql    # パスワード総当たり対策のスロットリング
supabase/migrations/0003_grants.sql        # service_role のみ許可、anon には一切与えない
supabase/migrations/0004_meetings_unique_open.sql
```

> **セルフホストの Supabase の場合：** PostgREST に `meet` スキーマを公開させる必要があります。Studio のチェックボックスはロール設定に上書きされて効かないことがあるので、次を実行してください：
> ```sql
> alter role authenticator set pgrst.db_schemas = 'public, graphql_public, meet';
> notify pgrst, 'reload config';
> ```

### 環境変数

| 変数 | 説明 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase の URL |
| `SUPABASE_ANON_KEY` | **意図的に `NEXT_PUBLIC_` を付けていません**——ブラウザから Supabase を直接叩かない設計のため、サーバー側専用の値です |
| `SUPABASE_SERVICE_ROLE_KEY` | サーバー専用。絶対に公開しないこと |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `docker run --rm livekit/generate` で生成 |
| `NEXT_PUBLIC_LIVEKIT_URL` | 例：`wss://livekit.example.com` |
| `APP_DOMAIN` | 招待リンクの生成に使用。空ならフォワードされたホスト名にフォールバックします（リバースプロキシ配下では正しく動きますが、本番では明示指定を推奨） |
| `MAX_CONCURRENT_PARTICIPANTS` | 全ルーム合計の同時接続上限（既定 `20`）。メディアサーバーの上り帯域に合わせて調整 |

### デプロイ

**1. LiveKit。** [公式ガイド](https://docs.livekit.io/home/self-hosting/deployment/)のどの方法でも構いません。単一ノードの最小構成：

```yaml
port: 7880
rtc:
  udp_port: 7882          # UDP は単一ポートに集約（50000-60000 の開放は不要）
  tcp_port: 7881          # UDP が塞がれた環境向けの TCP フォールバック
  use_external_ip: true
keys:
  <YOUR_API_KEY>: <YOUR_API_SECRET>
room:
  max_participants: 50
  empty_timeout: 300
  enable_remote_unmute: true   # ホストの「ミュート解除」に必須
webhook:
  api_key: <YOUR_API_KEY>
  urls:
    - https://<アプリのドメイン>/api/webhooks/livekit
```

ブラウザから `wss://` で到達できるよう、7880 番の前段に TLS（Caddy / nginx / プラットフォームの ingress）を置いてください。

> **NodePort が割り当てられる環境（Kubernetes 系ホスティング）では**、`udp_port`／`tcp_port` を NodePort のレンジ内の番号にして、コンテナのポートと外部ポートを 1:1 で一致させてください。LiveKit は自分が listen しているポートをそのまま広告するため、ズレると ICE が確立しません。

**2. アプリ本体。** 通常の Next.js サーバーアプリなので、Node が動く環境ならどこでも動きます（Vercel / Docker / VPS / 各種 PaaS）：

```bash
npm run build && npm start
```

**3. Webhook を** `https://<アプリのドメイン>/api/webhooks/livekit` に向けて LiveKit を再起動してください。これが無いと入退室の監査ログとピーク人数が記録されません。

### 設計上のポイント

- **ブラウザは Supabase に直接接続しません。** 読み書きはすべて本アプリの `/api/*` を経由し、service role キーはサーバー側だけに存在します。安全であることに加えて、参加者のブラウザが通信する相手が自分のドメインだけになるため、`*.supabase.co` が遅い・届かないネットワークからでも使えます。
- **`MediaProvider` 抽象。** `livekit-client` の import は `lib/media/providers/livekit/` 配下でのみ許可されます（ESLint と CI スクリプトの二重で強制）。他のコードは `lib/media/types.ts` のインターフェースにのみ依存するので、別の SFU に載せ替えてもページ・コンポーネント・ストアは一切変更不要です。
- **背景効果の資産はセルフホストです。** `@livekit/track-processors` は既定で wasm を jsdelivr から、セグメンテーションモデルを `storage.googleapis.com` から読み込みますが、どちらも中国本土からは到達できません。そのため常にローカル配信のコピーを指すようにしてあります（`npm run setup:assets` で取得。CDN に戻ってしまわないよう回帰テストでパスを固定しています）。
- **セキュリティ。** ルームのパスワードは bcrypt でハッシュ化し `password_hash` はサーバー外に出しません。IP × ルーム単位の入室スロットリング（10 分間に 10 回）、トークン発行時点での人数上限チェック、アクセストークンの TTL はルームの残り時間以内（最大 6 時間）。他人のルームと存在しないルームは同一の 404 を返すため、存在の探索ができません。

### コントリビュート

Issue・Pull Request を歓迎します。PR の前に：

```bash
npm test          # 877 テスト
npm run lint
npm run build
bash scripts/check-china-safe.sh   # 遮断される CDN 依存とレイヤ違反を検出
```

### ライセンス

MIT — [LICENSE](LICENSE) を参照してください。

---

## 简体中文

### 环境要求

- **Node.js 22 以上**（依赖的 `nanoid` v6 是纯 ESM，要求此版本）
- 一个 **Supabase** 项目（[云端](https://supabase.com) 或 [自托管](https://supabase.com/docs/guides/self-hosting)）
- 一台 **LiveKit** 服务器（[自托管](https://docs.livekit.io/home/self-hosting/deployment/) 或 [LiveKit Cloud](https://cloud.livekit.io)）

### 快速开始

```bash
git clone https://github.com/Sanlitukokusai/openmeet.git
cd openmeet
npm install                 # 会同时拉取背景效果所需的 MediaPipe 资产
cp .env.example .env.local  # 然后填写下表中的值
npm run dev                 # http://localhost:3000
```

按顺序把数据库迁移应用到你的 Supabase 项目（用 SQL 编辑器、`psql` 或 Supabase CLI 均可）：

```
supabase/migrations/0001_meet_schema.sql   # 建表、RLS 策略、触发器
supabase/migrations/0002_rate_limit.sql    # 密码爆破限流
supabase/migrations/0003_grants.sql        # 仅授权 service_role，anon 零权限
supabase/migrations/0004_meetings_unique_open.sql
```

> **自托管 Supabase 注意：** 需要让 PostgREST 暴露 `meet` schema。Studio 里勾选可能会被角色配置覆盖而不生效，稳妥做法是执行：
> ```sql
> alter role authenticator set pgrst.db_schemas = 'public, graphql_public, meet';
> notify pgrst, 'reload config';
> ```

### 环境变量

| 变量 | 说明 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 地址 |
| `SUPABASE_ANON_KEY` | **故意不加 `NEXT_PUBLIC_` 前缀**——本项目浏览器不直连 Supabase，这是服务端专用值 |
| `SUPABASE_SERVICE_ROLE_KEY` | 仅服务端使用，绝不可暴露 |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | 用 `docker run --rm livekit/generate` 生成 |
| `NEXT_PUBLIC_LIVEKIT_URL` | 例如 `wss://livekit.example.com` |
| `APP_DOMAIN` | 用于生成邀请链接。留空时回退到转发头中的主机名（反向代理后是正确的），但生产环境建议显式设置 |
| `MAX_CONCURRENT_PARTICIPANTS` | 全部房间合计的同时在线上限（默认 `20`），按你媒体服务器的上行带宽设定 |

### 部署

**1. LiveKit。** [官方指南](https://docs.livekit.io/home/self-hosting/deployment/)里的任意部署方式都可以。单节点最小配置：

```yaml
port: 7880
rtc:
  udp_port: 7882          # UDP 单端口复用，无需开放 50000-60000 大范围端口
  tcp_port: 7881          # 封锁 UDP 的网络走 TCP 回退
  use_external_ip: true
keys:
  <YOUR_API_KEY>: <YOUR_API_SECRET>
room:
  max_participants: 50
  empty_timeout: 300
  enable_remote_unmute: true   # 主持人「解除静音」功能必需
webhook:
  api_key: <YOUR_API_KEY>
  urls:
    - https://<你的应用域名>/api/webhooks/livekit
```

在 7880 端口前面放 TLS 终结（Caddy、nginx 或平台自带 ingress），让浏览器能通过 `wss://` 连上。

> **如果你的平台按 NodePort 分配端口**（Kubernetes 类托管），请把 `udp_port`/`tcp_port` 设成 NodePort 区间内的号码，使容器端口与外部端口 1:1 一致。LiveKit 会把自己监听的端口原样通告出去，两者不一致时 ICE 永远连不通。

**2. 应用本体。** 就是一个标准的 Next.js 服务端应用，任何能跑 Node 的地方都能部署（Vercel、Docker、VPS、各类 PaaS）：

```bash
npm run build && npm start
```

**3. 把 webhook 指向** `https://<你的应用域名>/api/webhooks/livekit` 并重启 LiveKit。不配这一步，入退室审计记录和峰值人数就不会被记录。

### 设计要点

- **浏览器从不直连 Supabase。** 所有读写都经过本应用的 `/api/*`，service role 密钥只存在于服务端。除了更安全之外，这还意味着参会者的浏览器只与你自己的域名通信——这正是本项目能在 `*.supabase.co` 缓慢或不可达的网络中正常使用的原因。
- **`MediaProvider` 抽象层。** `livekit-client` 只允许在 `lib/media/providers/livekit/` 下 import（ESLint 与 CI 脚本双重强制），其余代码一律只依赖 `lib/media/types.ts` 里的接口。要换成别的 SFU，只需新写一个 provider，页面、组件、状态层一行都不用动。
- **背景效果的模型资产全部自托管。** `@livekit/track-processors` 默认从 jsdelivr 加载 wasm、从 `storage.googleapis.com` 加载分割模型，这两个地址在中国大陆都不可达。因此本项目始终指向本地提供的副本（`npm run setup:assets` 负责获取，并有回归测试钉死路径，防止有人不慎改回 CDN）。
- **安全设计。** 房间密码用 bcrypt 哈希，`password_hash` 绝不离开服务端；按 IP × 房间的入会限流（10 分钟 10 次）；人数上限在签发 token 时强制；访问令牌有效期不超过房间剩余时长（最长 6 小时）；他人的房间与不存在的房间返回完全相同的 404，无法探测房间是否存在。

### 参与贡献

欢迎提 Issue 和 Pull Request。提交 PR 前请先跑：

```bash
npm test          # 877 个测试
npm run lint
npm run build
bash scripts/check-china-safe.sh   # 检查被墙依赖与分层违规
```

### 许可证

MIT，详见 [LICENSE](LICENSE)。
