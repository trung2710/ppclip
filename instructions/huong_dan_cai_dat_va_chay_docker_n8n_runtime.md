# Hướng Dẫn Cài Đặt Và Chạy Paperclip Docker Với n8n Runtime Adapter

Tài liệu này hướng dẫn build image Paperclip, chạy container, thiết lập tài khoản quản trị và cài external adapter `n8n_runtime`.

## 1. Build Image

Mở PowerShell và chạy:

```powershell
cd C:\paperclip
docker build --no-cache --target production -t paperclip:n8n-test .
```

Lệnh trên build lại image từ đầu, đồng thời build adapter tại:

```text
/app/n8n-runtime-adapter/dist
```

## 2. Tạo Secret Cho Paperclip

Có thể dùng giá trị `BETTER_AUTH_SECRET` đang có trong file `.env` Windows.

Hoặc tự tạo secret mới bằng PowerShell:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Ví dụ kết quả:

```text
pfUFZeTx+dblWOG1p/Jn5fGTaablAeF/DFGWg5q5EJ4=
```

Secret này chỉ dùng cho môi trường test. Khi triển khai thật, cần dùng secret riêng và bảo mật.

## 3. Chạy Container Lần Đầu

```powershell
docker run -d `
  --name paperclip-n8n-test `
  -p 3100:3100 `
  -v paperclip_data:/paperclip `
  -e PAPERCLIP_DEPLOYMENT_MODE=authenticated `
  -e BETTER_AUTH_SECRET=pfUFZeTx+dblWOG1p/Jn5fGTaablAeF/DFGWg5q5EJ4= `
  -e BETTER_AUTH_URL=http://localhost:3100 `
  paperclip:n8n-test
```

Trong lệnh trên:

- `-p 3100:3100`: mở Paperclip tại `http://localhost:3100`.
- `-v paperclip_data:/paperclip`: lưu database embedded và dữ liệu Paperclip trong Docker volume.
- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`: bật chế độ xác thực.
- `BETTER_AUTH_SECRET`: secret dùng để ký phiên đăng nhập.
- `BETTER_AUTH_URL`: URL Paperclip trên máy Windows.

## 4. Xem Log Paperclip

```powershell
docker logs -f paperclip-n8n-test
```

## 5. Cấu Hình Đăng Nhập Và Người Dùng Hệ Thống

Mở shell bên trong container:

```powershell
docker exec -it paperclip-n8n-test sh
```

Trong container, chạy:

```sh
cd /app
pnpm paperclipai onboard

pnpm paperclipai auth bootstrap-ceo
```

Nếu CLI in ra URL xác thực, mở URL đó trên trình duyệt và hoàn tất thiết lập tài khoản quản trị.

## 6. Kiểm Tra Và Cài External Adapter

Vẫn chạy bên trong container Paperclip:

```sh
test -f /app/n8n-runtime-adapter/dist/index.js && echo "Adapter OK"
cd /app
```

Nếu kết quả là `Adapter OK`, cài adapter:

```sh
pnpm paperclipai adapter install --payload-json '{"packageName":"/app/n8n-runtime-adapter","isLocalPath":true}'
```

Kiểm tra adapter đã được đăng ký:

```sh
pnpm paperclipai adapter list

pnpm paperclipai adapter get n8n_runtime
/app/n8n-runtime-adapter
```

Đường dẫn adapter phải là:

```text
/app/n8n-runtime-adapter
```

Không sử dụng đường dẫn Windows:

```text
C:\paperclip\n8n-runtime-adapter
```

## 7. Quản Lý Container

### Dừng Container

```powershell
docker stop paperclip-n8n-test
```

### Khởi Động Lại Container Đã Tồn Tại

```powershell
docker start paperclip-n8n-test
```

### Xóa Container

Chỉ dùng lệnh này khi muốn xóa container để tạo lại. Lệnh này không xóa volume `paperclip_data`:

```powershell
docker rm paperclip-n8n-test
```

### Tạo Lại Container Với Volume Cũ

Nếu đã xóa container nhưng vẫn muốn dùng dữ liệu cũ trong volume `paperclip_data`, chạy:

```powershell
docker run -d `
  --name paperclip-n8n-test `
  -p 3100:3100 `
  -v paperclip_data:/paperclip `
  paperclip:n8n-test
```

Không xóa volume bằng lệnh sau nếu muốn giữ dữ liệu:

```powershell
docker volume rm paperclip_data
```

## 8. Cho Phép n8n Gọi Paperclip Qua `host.docker.internal`

Nếu n8n chạy trong Docker và gọi Paperclip bằng URL:

```text
http://host.docker.internal:3100/api/issues/{issueId}/comments
```

thì cần cho phép hostname này trong Paperclip.

Mở shell container:

```powershell
docker exec -it paperclip-n8n-test sh
```

Trong container, chạy:

```sh
cd /app
pnpm paperclipai allowed-hostname host.docker.internal
```

Sau đó thoát container và restart Paperclip:

```sh
exit
```

```powershell
docker restart paperclip-n8n-test
```

Sau bước này, n8n có thể gọi:

```text
http://host.docker.internal:3100/api/issues/{issueId}/comments
```

Trong đó `{issueId}` phải được thay bằng ID issue thực tế.

## 9. Cấu Hình Agent `n8n_runtime`

Sau khi cài adapter, mở giao diện:

```text
http://localhost:3100
```

Trong agent cần cấu hình:

- Adapter type: `n8n_runtime`
- Webhook URL: webhook của n8n
- n8n Base URL: URL mà container Paperclip truy cập được
- Workflow ID: ID workflow n8n
- n8n API Key: API key dùng để đọc Execution API
- Log detail: `Verbose` nếu muốn hiển thị output chi tiết của node

`N8N_API_KEY` chỉ dùng để Paperclip đọc execution của n8n. Token Bearer trong các node n8n gọi API Paperclip là token riêng của Paperclip.

## 10. Quy Trình Chạy Lại Sau Khi Sửa Adapter

```powershell
cd C:\paperclip
docker build --no-cache --target production -t paperclip:n8n-test .
docker rm -f paperclip-n8n-test
```

Sau đó chạy lại container bằng lệnh ở mục 3. Volume `paperclip_data` vẫn được giữ nguyên.

