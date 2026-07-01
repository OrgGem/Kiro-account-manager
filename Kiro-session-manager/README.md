# Kiro Session Manager

Kiro Session Manager là một công cụ dòng lệnh (CLI) độc lập, được trích xuất từ lõi của Kiro-account-manager. Công cụ này chuyên chịu trách nhiệm xử lý các thao tác:
- Đăng nhập vào hệ thống AWS SSO Enterprise thông qua Device Code Auth.
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

Lệnh này sẽ khởi tạo quy trình xác thực thiết bị (Device Auth Flow).

```bash
# Sử dụng cấu hình mặc định đã lưu
kiro-session login

# Hoặc truyền tham số để ghi đè cấu hình hiện tại
kiro-session login -u "https://other.awsapps.com/start" -r eu-central-1 -p "http://127.0.0.1:1080"
```

**Quá trình đăng nhập:**
1. CLI sẽ gọi API AWS để lấy Device Code.
2. CLI sẽ tự động mở trình duyệt web đến trang đăng nhập của AWS SSO.
3. Nếu AWS yêu cầu, bạn sẽ cần xác nhận mã Device Code hiển thị trên Terminal vào trình duyệt.
4. Sau khi bạn chấp thuận trên trình duyệt, CLI sẽ tự động nhận diện, lấy token thành công và lưu vào `~/.aws/sso/cache/kiro-auth-token.json`.

### 3. Khởi chạy thông minh (Smart Start)

Bạn có thể dùng lệnh `start` để ứng dụng tự động kiểm tra xem có cần login không, và sau đó tự động bắt đầu vòng lặp auto-refresh:

```bash
kiro-session start --interval 5
```

- Nếu token chưa có hoặc đã hết hạn, ứng dụng sẽ tự động gọi luồng SSO Login.
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
