# Báo cáo: Khởi tạo và kiểm soát custom agent trong Paperclip

Ngày lập: 2026-08-04

## 1. Mục tiêu tìm hiểu

Task được giao là tìm hiểu khi mới khởi tạo một agent trong Paperclip thì có thể tùy biến agent đó đến mức nào, bao gồm:

- Tạo một agent custom theo nhu cầu riêng.
- Viết lại hoặc tinh chỉnh skill để hướng dẫn agent làm việc đúng ý mình hơn.
- Gán skill vào agent khi khởi tạo hoặc sau khi đã tạo.
- Gán quyền, capability và các cấu hình khác để kiểm soát hành vi của agent.
- Kiểm tra trường hợp agent sử dụng `http` adapter.

Kết luận tổng quát: Paperclip cho phép tạo custom agent, gán skill riêng, gán capability, gán permission và chỉ định quan hệ cha-con thông qua `reportsTo`. Tuy nhiên, mức độ "kiểm soát thực sự" phụ thuộc vào adapter và runtime có đọc, đồng bộ và thực thi skill hay không.

## 2. Các endpoint chính

### 2.1. Tạo skill riêng cho company

Endpoint:

```http
POST /api/companies/:companyId/skills
```

Mục đích:

- Tạo một skill nội bộ trong company.
- Nội dung skill được viết bằng markdown.
- Skill sau khi tạo có thể gán vào agent thông qua `desiredSkills`.

Ví dụ body:

```json
{
  "name": "Agent QA Skill",
  "slug": "agent-qa-skill",
  "description": "Skill chuyên dùng để test gán vào agent custom",
  "markdown": "# Agent QA Skill\n\n## Mục tiêu\n- Xử lý test flow cơ bản\n- Kiểm tra gán skill vào agent\n\n## Quy tắc\n- Trả lời ngắn gọn\n- Không tự ý thay đổi dữ liệu ngoài phạm vi test",
  "tagline": "Skill test chuyên biệt cho agent",
  "authorName": "Paperclip QA",
  "sharingScope": "company"
}
```

Skill key thường có dạng:

```text
company/<companyId>/<slug>
```

Ví dụ:

```text
company/81ed1694-1183-47f8-8898-507b8b2f6520/agent-qa-skill
```

## 3. Tạo custom agent

Endpoint:

```http
POST /api/companies/:companyId/agents
```

Những field quan trọng khi tạo agent:

- `name`: tên agent.
- `role`: vai trò hoặc nhóm agent, ví dụ `qa`, `engineer`, `manager`.
- `title`: chức danh hiển thị.
- `reportsTo`: agent cha hoặc agent quản lý trực tiếp, dùng để tạo quan hệ agent cha-con.
- `adapterType`: loại adapter, ví dụ `http`.
- `adapterConfig`: cấu hình runtime của adapter.
- `capabilities`: mô tả agent có khả năng làm gì.
- `permissions`: object quyền hệ thống.
- `desiredSkills`: danh sách skill muốn gán cho agent.
- `metadata`: metadata bổ sung.

Ví dụ body tạo agent dùng `http` adapter và gán skill ngay lúc tạo:

```json
{
  "name": "QA Test Agent",
  "role": "qa",
  "title": "Agent test gán skill",
  "reportsTo": null,
  "adapterType": "http",
  "adapterConfig": {
    "url": "http://localhost:3000/webhook/test-agent",
    "method": "POST"
  },
  "capabilities": "Chạy test flow, nhận request HTTP, phản hồi JSON",
  "permissions": {},
  "desiredSkills": [
    "company/81ed1694-1183-47f8-8898-507b8b2f6520/agent-qa-skill"
  ],
  "budgetMonthlyCents": 0,
  "metadata": {
    "source": "postman",
    "purpose": "skill-assignment-test"
  }
}
```

Lưu ý: `permissions` phải là object. Nếu gửi mảng như `["read", "write"]` thì API sẽ trả về lỗi validation:

```text
Expected object, received array
```

## 4. Gán skill sau khi đã tạo agent

Nếu không gán skill khi tạo agent, có thể gán sau bằng endpoint:

```http
POST /api/agents/:id/skills/sync
```

Ví dụ body:

```json
{
  "desiredSkills": [
    "company/81ed1694-1183-47f8-8898-507b8b2f6520/agent-qa-skill"
  ]
}
```

Endpoint này dùng để đồng bộ danh sách skill mong muốn của agent. Về mặt dữ liệu, Paperclip sẽ lưu danh sách skill trong cấu hình của agent.

## 5. Role có tự gán skill mặc định không?

Qua kiểm tra logic backend, `role` không tự động sinh ra skill mặc định cho agent được tạo thủ công qua API.

Bản chất của `role`:

- Là nhãn phân loại agent.
- Hỗ trợ hiển thị, grouping, routing hoặc orchestration.
- Không thay thế `desiredSkills`.
- Không tự động map sang bộ skill riêng nếu flow tạo agent bình thường không truyền `desiredSkills`.

Vì vậy, nếu muốn agent có skill cụ thể thì cần truyền `desiredSkills` khi tạo agent hoặc gọi endpoint sync skill sau đó.

## 6. Skill có tác dụng gì với agent dùng http adapter?

Với `http` adapter, việc gán skill có ý nghĩa ở tầng cấu hình và điều phối, nhưng không tự động biến webhook HTTP thành agent biết làm theo skill.

Cụ thể:

- Paperclip lưu skill như một phần của cấu hình agent.
- UI và control plane có thể hiển thị agent đang được gán skill nào.
- Hệ thống có thể dùng skill cho routing, audit, trace hoặc sinh context nếu runtime hỗ trợ.
- Nếu adapter có cơ chế sync skill, Paperclip có thể đồng bộ skill xuống adapter.
- Nếu endpoint HTTP bên ngoài không đọc skill/context, thì skill chủ yếu là metadata.

Kết luận quan trọng:

```text
Với http adapter, skill chỉ thật sự có tác dụng thực thi khi Paperclip truyền skill/context vào request hoặc service HTTP phía ngoài chủ động đọc và xử lý skill đó.
```

## 7. Permission có tự tạo thêm được không?

Permission hiện tại là bộ quyền cố định của hệ thống, không phải danh sách string tùy ý.

Trong UI hiện tại có các quyền như:

- Can create new agents.
- Can create/import skills.
- Can assign tasks.

Việc bật/tắt các quyền này là cấu hình trên agent. Nếu muốn thêm permission mới, cần sửa code backend và UI, gồm:

- Validator/type cho permission.
- Logic authorize trên server.
- UI permission panel.
- Nơi lưu trữ/cập nhật permission nếu schema có ràng buộc.

Vì vậy, không nên gửi:

```json
{
  "permissions": ["read", "write"]
}
```

Mà nên gửi object hợp lệ, hoặc bỏ qua `permissions` trong giai đoạn test:

```json
{
  "permissions": {}
}
```

## 8. Capabilities khác gì skill và permission?

`capabilities` là mô tả năng lực ở dạng text/metadata. Nó giúp con người và hệ thống hiểu agent có thể làm gì, nhưng không phải là quyền được enforce cứng.

So sánh ngắn gọn:

| Thành phần | Vai trò |
| --- | --- |
| `role` | Phân loại agent |
| `capabilities` | Mô tả agent có khả năng làm gì |
| `permissions` | Quyền hệ thống được phép thực hiện |
| `desiredSkills` | Skill/hướng dẫn chuyên biệt gán cho agent |
| `adapterConfig` | Cách agent được chạy/thực thi |
| `reportsTo` | Quan hệ agent cha-con |

## 9. Tạo agent con của agent khác

Để tạo agent con, truyền `reportsTo` bằng id của agent cha:

```json
{
  "name": "Child QA Agent",
  "role": "qa",
  "reportsTo": "<parent-agent-id>",
  "adapterType": "http",
  "adapterConfig": {
    "url": "http://localhost:3000/webhook/child-agent",
    "method": "POST"
  },
  "capabilities": "Xử lý các task QA được giao từ agent cha",
  "permissions": {},
  "desiredSkills": [
    "company/81ed1694-1183-47f8-8898-507b8b2f6520/agent-qa-skill"
  ]
}
```

`reportsTo` chỉ ra quan hệ báo cáo/quản lý. Việc agent cha có thật sự điều phối agent con hay không còn phụ thuộc vào logic orchestration của Paperclip và workflow đang chạy.

## 10. Quy trình test trên Postman

### Bước 1: Chuẩn bị biến môi trường

```text
baseUrl = http://host.docker.internal:3100
companyId = 81ed1694-1183-47f8-8898-507b8b2f6520
agentId = <điền sau khi tạo agent>
```

Header:

```http
Content-Type: application/json
Authorization: Bearer <token>
```

### Bước 2: Tạo skill

```http
POST {{baseUrl}}/api/companies/{{companyId}}/skills
```

Dùng body ở mục 2.1.

### Bước 3: Tạo agent

```http
POST {{baseUrl}}/api/companies/{{companyId}}/agents
```

Dùng body ở mục 3.

### Bước 4: Gán/sync skill nếu cần

```http
POST {{baseUrl}}/api/agents/{{agentId}}/skills/sync
```

Body:

```json
{
  "desiredSkills": [
    "company/{{companyId}}/agent-qa-skill"
  ]
}
```

### Bước 5: Kiểm tra kết quả

Cần kiểm tra:

- Agent tạo thành công.
- `adapterType` là `http`.
- `adapterConfig.url` đúng webhook mong muốn.
- `desiredSkills` chứa skill đã tạo.
- `permissions` không bị lỗi validation.
- Nếu chạy runtime qua HTTP, endpoint bên ngoài nhận đủ payload cần thiết.

## 11. Kiến nghị để control agent tốt hơn

Nếu mục tiêu là control agent theo ý mình, nên tách thành 3 lớp:

1. Skill markdown

Dùng để mô tả cách làm việc, quy tắc, ranh giới, format đầu ra và các việc agent không được làm.

2. Permission

Dùng để giới hạn quyền hệ thống, ví dụ có được tạo agent, import skill, assign task hay không.

3. Runtime adapter

Với `http` adapter, cần đảm bảo webhook/agent service bên ngoài nhận đủ context để thực thi. Nếu Paperclip không tự truyền nội dung skill, service HTTP cần gọi API Paperclip để lấy thông tin agent/skill hoặc nhận skill qua payload từ workflow.

## 12. Kết luận

Paperclip hỗ trợ tạo custom agent và gán skill theo ý mình. Tuy nhiên, `role`, `capabilities`, `permissions` và `desiredSkills` không giống nhau:

- `role` chỉ là vai trò/nhóm.
- `capabilities` là mô tả năng lực.
- `permissions` là quyền hệ thống cố định.
- `desiredSkills` là bộ skill mong muốn gán vào agent.

Với agent dùng `http` adapter, skill sẽ có tác dụng lớn nhất khi runtime HTTP của agent có đọc và áp dụng skill trong quá trình xử lý task. Nếu không, skill chủ yếu là cấu hình/metadata để Paperclip quản lý và điều phối.

