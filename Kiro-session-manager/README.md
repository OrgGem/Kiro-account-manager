# Kiro Session Manager

Kiro Session Manager là một công cụ dòng lệnh (CLI) độc lập, được trích xuất từ lõi của Kiro-account-manager. Công cụ này chuyên chịu trách nhiệm xử lý các thao tác:
- Đăng nhập vào hệ thống AWS SSO Enterprise thông qua **IAM Identity Center PKCE** (mặc định) hoặc **Device Code Auth** (fallback).
- Tự động duy trì và làm mới (auto-refresh) token để đảm bảo phiên làm việc (session) không bị gián đoạn.
- Đồng bộ token trực tiếp vào file cấu hình gốc (`~/.aws/sso/cache/kiro-auth-token.json`) tương thích hoàn toàn với Kiro IDE.
- Hỗ trợ kết nối qua HTTP/HTTPS Proxy dành cho các môi trường mạng nội bộ hoặc bị giới hạn.

## Cài đặt

Yêu cầu: Đã cài đặt [Node.js](https://nodejs.org/) trên máy tính.

Tải mã nguồn và cài đặt dependencies:

```bash
cd Kiro-session-manager
npm install
npm run build
```

Cài đặt CLI thành một lệnh Global (để có thể gọi từ bất kỳ đâu):

```bash
npm install -g .
```

Sau khi cài đặt thành công, bạn sẽ có lệnh `kiro-session` khả dụng trong terminal.

## Hướng dẫn sử dụng

### 1. Cấu hình ban đầu (Optional)

Bạn có thể lưu các cấu hình mặc định (như URL đăng nhập SSO, region, hoặc Proxy) để không phải nhập lại mỗi lần chạy lệnh. Cấu hình này được lưu tại `~/.aws/sso/cache/kiro-session-config.json`.

```bash
# Thiết lập cấu hình
kiro-session config --startUrl "https://my-company.awsapps.com/start" --region us-east-1 --proxy "http://127.0.0.1:1080"

# Xem cấu hình hiện tại
kiro-session config
```

### 2. Đăng nhập (SSO Login)

Lệnh `login` hỗ trợ hai luồng xác thực:

#### PKCE (mặc định) – IAM Identity Center browser redirect

Đây là luồng xác thực chính, tương thích hoàn toàn với Kiro IDE. CLI sẽ:
1. Đăng ký OIDC client với grant type `authorization_code`.
2. Tạo PKCE code verifier/challenge và state.
3. Khởi động một HTTP server cục bộ trên `127.0.0.1` (ephemeral port) để đón callback.
4. Tự động mở trình duyệt đến trang đăng nhập AWS SSO. URL cũng được in ra terminal để bạn mở thủ công nếu cần.
5. Sau khi bạn xác thực trên trình duyệt, AWS sẽ redirect về localhost, CLI nhận mã authorization code và trao đổi lấy token.

```bash
# Sử dụng cấu hình mặc định đã lưu
kiro-session login

# Hoặc truyền tham số trực tiếp
kiro-session login -u "https://my-company.awsapps.com/start" -r us-east-1
```

#### Device Code (fallback)

Nếu môi trường không hỗ trợ browser redirect (ví dụ: headless server), bạn có thể dùng Device Code flow:

```bash
kiro-session login --flow device
```

### 3. Khởi chạy thông minh (Smart Start)

Bạn có thể dùng lệnh `start` để ứng dụng tự động kiểm tra xem có cần login không, và sau đó tự động bắt đầu vòng lặp auto-refresh:

```bash
kiro-session start --interval 5
```

- Nếu token chưa có hoặc đã hết hạn và không thể refresh, ứng dụng sẽ tự động gọi luồng SSO Login.
- Nếu token vẫn còn hạn, ứng dụng sẽ bỏ qua login và lập tức bắt đầu `start-refresh-loop`.

### 4. Vòng lặp làm mới Token độc lập (Auto-Refresh Loop)

Nếu bạn chỉ muốn chạy riêng tiến trình ngầm để tự động kiểm tra và gia hạn token:

```bash
# Chạy vòng lặp kiểm tra mỗi 5 phút (mặc định)
kiro-session start-refresh-loop --interval 5

# Hoặc truyền tham số Proxy nếu cần
kiro-session start-refresh-loop --interval 5 -p "http://127.0.0.1:1080"
```

Tiến trình này sẽ đọc token từ cache mỗi 5 phút. Nếu phát hiện token sẽ hết hạn trong vòng 10 phút tới, nó sẽ tự động dùng `refreshToken` để gọi OIDC đổi lấy một `accessToken` mới và ghi đè lại vào file.

## Các lệnh khả dụng (Commands Help)

Để xem danh sách toàn bộ các lệnh và cờ (flags) hỗ trợ, hãy dùng:

```bash
kiro-session --help
```

## Luồng xác thực (Authentication Flows)

### PKCE Authorization Code (mặc định)

```
CLI ──► OIDC /client/register (authorization_code + refresh_token)
     ──► Tạo PKCE code_verifier, code_challenge, state
     ──► Khởi chạy HTTP server trên 127.0.0.1:<port>/oauth/callback
     ──► Mở trình duyệt → /authorize?...&code_challenge=...
     ──► User xác thực trên trình duyệt
     ──► AWS redirect → 127.0.0.1:<port>/oauth/callback?code=...&state=...
     ──► CLI validate state, exchange code → /token (authorization_code + codeVerifier)
     ──► Lưu token + client registration vào ~/.aws/sso/cache/
```

### Device Code (fallback)

```
CLI ──► OIDC /client/register (device_code + refresh_token)
     ──► /device_authorization → nhận deviceCode + userCode
     ──► Mở trình duyệt + hiện userCode
     ──► Poll /token cho đến khi user approve
     ──► Lưu token + client registration vào ~/.aws/sso/cache/
```
