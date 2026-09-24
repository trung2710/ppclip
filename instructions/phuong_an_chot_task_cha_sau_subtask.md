# Phương án chốt task cha sau khi sub-task hoàn thành

## 1. Bối cảnh

Trong luồng demo multi-agent:

```text
CEO nhận query
-> tạo task cha
-> phân tích câu hỏi
-> tạo sub-task cho HR hoặc Kế Toán
-> agent con xử lý sub-task
-> agent con cập nhật sub-task = done
```

Vấn đề còn lại:

```text
Sub-task đã done nhưng task cha vẫn chưa tự hoàn tất.
```

Điều này là bình thường. Paperclip không nên mặc định hiểu rằng task cha done chỉ vì một task con done, vì task cha có thể có nhiều sub-task, cần nghiệm thu, cần tổng hợp kết quả, hoặc cần con người/CEO phê duyệt.

Vì vậy cần thêm logic chốt task cha.

## 2. Phân biệt run và task status

Có hai khái niệm khác nhau:

```text
Run success = workflow/adapter đã chạy thành công phase hiện tại.
Task done = công việc nghiệp vụ của issue đã hoàn tất.
```

Ví dụ workflow CEO:

```text
CEO nhận query
-> tạo task cha
-> tạo sub-task
-> respond webhook success
```

Run CEO có thể `success`, nhưng task cha vẫn nên là:

```text
in_progress
```

vì công việc thật đang chờ agent con xử lý.

## 3. Cách 1: Agent con tự cập nhật task cha sau khi xong

Đây là cách đơn giản nhất cho demo.

Luồng:

```text
Workflow HR/KT
-> xử lý sub-task
-> tạo report/comment trên sub-task
-> PATCH sub-task = done
-> GET sub-task để lấy parentId
-> PATCH parent task = done
-> POST comment vào parent task
```

Endpoint lấy task con:

```http
GET /api/issues/{childIssueId}
```

Lấy:

```text
parentId
```

Endpoint cập nhật task cha:

```http
PATCH /api/issues/{parentId}
```

Body:

```json
{
  "status": "done"
}
```

Endpoint comment vào task cha:

```http
POST /api/issues/{parentId}/comments
```

Body:

```json
{
  "body": "Agent con đã hoàn thành sub-task. Task cha được nghiệm thu và chuyển sang done."
}
```

Ưu điểm:

- Dễ làm nhất.
- Ít node.
- Demo nhanh, dễ hiểu.

Nhược điểm:

- Nếu task cha có nhiều sub-task, agent con đầu tiên hoàn thành có thể đóng task cha quá sớm.
- Logic nghiệm thu nằm ở agent con, không thật sự giống mô hình CEO kiểm soát.

Phù hợp khi:

```text
Mỗi task cha chỉ có một sub-task.
Demo nhanh.
```

## 4. Cách 2: Agent con báo cáo lên task cha, CEO/người dùng nghiệm thu

Luồng:

```text
Workflow HR/KT
-> xử lý sub-task
-> tạo report trên sub-task
-> PATCH sub-task = done
-> POST comment vào task cha: "Sub-task đã hoàn thành, chờ nghiệm thu"
-> PATCH task cha = in_review
```

Task cha không chuyển `done` ngay mà chuyển:

```text
in_review
```

Sau đó CEO hoặc người dùng kiểm tra kết quả rồi chuyển task cha sang:

```text
done
```

Comment parent ví dụ:

```json
{
  "body": "Sub-task Kế Toán đã hoàn thành và báo cáo kết quả đã được tạo. Task cha đang chờ nghiệm thu."
}
```

Update parent:

```json
{
  "status": "in_review"
}
```

Ưu điểm:

- Thể hiện đúng governance.
- Có bước nghiệm thu rõ ràng.
- Tránh đóng task cha quá sớm.
- Demo đẹp cho mô hình CEO giao việc và kiểm soát kết quả.

Nhược điểm:

- Cần người dùng/CEO bấm hoặc chạy thêm bước nghiệm thu.

Phù hợp khi:

```text
Muốn trình bày quy trình quản lý rõ ràng.
Muốn chứng minh Paperclip không chỉ tự động chạy mà còn có kiểm soát.
```

## 5. Cách 3: Workflow finalizer riêng

Tạo một workflow riêng chuyên chốt task cha.

Luồng:

```text
Agent con done
-> gọi webhook finalizer
-> finalizer nhận parentIssueId
-> GET danh sách sub-task của parent
-> kiểm tra tất cả sub-task đã done chưa
-> nếu tất cả done: PATCH parent = done
-> comment tổng hợp vào parent
```

Webhook finalizer input:

```json
{
  "parentIssueId": "parent-id",
  "childIssueId": "child-id",
  "agentName": "HR",
  "summary": "HR đã hoàn thành phân tích tuyển dụng."
}
```

Logic:

```text
Nếu còn sub-task chưa done:
  comment parent: "Sub-task X đã xong, vẫn còn sub-task khác đang chạy."
  giữ parent = in_progress

Nếu tất cả sub-task done:
  tổng hợp kết quả
  PATCH parent = done
  comment parent: "Tất cả sub-task đã hoàn thành."
```

Ưu điểm:

- Sạch về kiến trúc.
- Dùng được cho nhiều agent con.
- Không để agent con tự quyết định đóng task cha.
- Phù hợp khi có HR, Kế Toán, Sales cùng chạy.

Nhược điểm:

- Cần thêm workflow.
- Cần endpoint/list sub-task hoặc lấy detail task cha có danh sách con.
- Cần xử lý concurrency nếu nhiều task con xong gần nhau.

Phù hợp khi:

```text
Muốn demo nhiều sub-task song song.
Muốn kiến trúc gần production hơn.
```

## 6. Cách 4: CEO workflow có webhook nghiệm thu riêng

Thay vì tạo workflow finalizer độc lập, chính workflow CEO có thêm một webhook thứ hai.

Luồng:

```text
Workflow CEO - webhook nhận query
-> tạo task cha
-> tạo sub-task
-> parent = in_progress

Workflow CEO - webhook nghiệm thu
-> được agent con gọi khi xong
-> nhận parentIssueId
-> kiểm tra sub-task
-> comment tổng hợp
-> parent = done hoặc in_review
```

Ưu điểm:

- Thể hiện CEO vừa giao việc vừa nghiệm thu.
- Ít tách thành nhiều workflow hơn finalizer riêng.
- Dễ giải thích: "agent con báo lại CEO".

Nhược điểm:

- Workflow CEO có nhiều webhook/entrypoint hơn, dễ rối nếu demo không chuẩn bị kỹ.

Phù hợp khi:

```text
Muốn nhấn mạnh vai trò CEO/manager agent.
```

## 7. Cách 5: Dựa vào automation/monitor nội bộ của Paperclip

Ý tưởng:

```text
Task cha in_progress
Sub-task done
Paperclip monitor phát hiện trạng thái cần xử lý tiếp
-> kích hoạt run/wakeup để CEO chốt task cha
```

Ưu điểm:

- Đúng hướng hệ thống tự động điều phối.
- Ít logic thủ công trong n8n hơn nếu Paperclip đã có rule phù hợp.

Nhược điểm:

- Khó demo chủ động.
- Phụ thuộc scheduler/automation/rule nội bộ.
- Khó kiểm soát thời điểm chạy.

Phù hợp khi:

```text
Đã hiểu rõ automation của Paperclip và có thời gian cấu hình.
Không phù hợp demo nhanh.
```

## 8. Cách 6: Không chốt task cha tự động

Với demo đơn giản, có thể để:

```text
Task cha = in_progress hoặc in_review
Sub-task = done
```

Thông điệp trình bày:

```text
Task cha là container quản lý.
Sub-task là đơn vị thực thi.
Kết quả nằm ở task con.
```

Ưu điểm:

- Rất đơn giản.
- Không cần thêm logic.

Nhược điểm:

- Chưa khép vòng lifecycle.
- Sếp có thể hỏi tại sao task cha chưa done.

Phù hợp khi:

```text
Chỉ muốn demo quan hệ cha/con và agent giao việc.
Không cần demo nghiệm thu.
```

## 9. Khuyến nghị cho demo hiện tại

Với workflow hiện tại:

```text
CEO
-> tạo task cha
-> phân tích query
-> tạo sub-task HR hoặc Kế Toán
-> parent = in_progress

HR/KT
-> xử lý sub-task
-> tạo report
-> child = done
```

Khuyến nghị demo đẹp nhất:

```text
Agent con hoàn thành
-> comment vào task cha
-> PATCH task cha = in_review
-> người dùng/CEO nghiệm thu sang done
```

Lý do:

- Không đóng task cha quá sớm.
- Thể hiện rõ bước nghiệm thu.
- Dễ giải thích với sếp.
- Ít phức tạp hơn finalizer đầy đủ.

Nếu muốn demo tự động khép vòng ngay:

```text
Agent con hoàn thành
-> GET task con lấy parentId
-> PATCH parent = done
-> POST comment parent
```

Chỉ nên dùng nếu mỗi task cha có đúng một sub-task.

## 10. Flow đề xuất ngắn gọn

## Demo có nghiệm thu

```text
Workflow CEO:
Webhook CEO
-> tạo task cha
-> phân tích query
-> tạo sub-task cho HR/KT
-> PATCH task cha = in_progress
-> Respond Webhook
```

```text
Workflow HR/KT:
Webhook agent con
-> xử lý task con
-> tạo report document
-> PATCH task con = done
-> GET task con lấy parentId
-> POST comment vào task cha
-> PATCH task cha = in_review
-> Respond Webhook
```

```text
Người dùng/CEO:
Review task cha
-> PATCH task cha = done
```

## Demo tự động hoàn tất

```text
Workflow HR/KT:
Webhook agent con
-> xử lý task con
-> tạo report document
-> PATCH task con = done
-> GET task con lấy parentId
-> POST comment vào task cha
-> PATCH task cha = done
-> Respond Webhook
```

## 11. Endpoint cần dùng

Lấy task con:

```http
GET /api/issues/{childIssueId}
```

Comment task cha:

```http
POST /api/issues/{parentIssueId}/comments
```

Body:

```json
{
  "body": "Sub-task đã hoàn thành và báo cáo đã được tạo."
}
```

Cập nhật task cha sang `in_review`:

```http
PATCH /api/issues/{parentIssueId}
```

Body:

```json
{
  "status": "in_review"
}
```

Cập nhật task cha sang `done`:

```http
PATCH /api/issues/{parentIssueId}
```

Body:

```json
{
  "status": "done"
}
```

## 12. Cấu hình nhanh trên n8n

### 12.1 Lấy `parentId` từ task con

Trong workflow HR/KT, sau khi xử lý xong sub-task, thêm node HTTP Request:

```text
Tên node: Lấy thông tin task con
Method: GET
URL: http://host.docker.internal:3100/api/issues/{{ $('HR').item.json.body.issueId || $('HR').item.json.query.issueId }}
Authentication: Bearer Auth
```

Nếu workflow chạy trong Docker cùng network với Paperclip, URL có thể đổi thành:

```text
http://paperclip:3100/api/issues/{{ $('HR').item.json.body.issueId || $('HR').item.json.query.issueId }}
```

Output node này sẽ có:

```text
$json.parentId
```

### 12.2 Comment báo kết quả về task cha

Thêm node HTTP Request:

```text
Tên node: Comment task cha
Method: POST
URL: http://host.docker.internal:3100/api/issues/{{ $('Lấy thông tin task con').item.json.parentId }}/comments
Authentication: Bearer Auth
Body Content Type: JSON
```

Body:

```json
{
  "body": "Sub-task đã hoàn thành. Agent con đã tạo báo cáo kết quả và chuyển task cha sang trạng thái chờ nghiệm thu."
}
```

### 12.3 Chuyển task cha sang `in_review`

Thêm node HTTP Request:

```text
Tên node: Cập nhật task cha in_review
Method: PATCH
URL: http://host.docker.internal:3100/api/issues/{{ $('Lấy thông tin task con').item.json.parentId }}
Authentication: Bearer Auth
Body Content Type: JSON
```

Body:

```json
{
  "status": "in_review"
}
```

### 12.4 Chuyển task cha sang `done` nếu muốn tự động hoàn tất

Nếu demo chỉ có một sub-task, có thể dùng node PATCH tương tự nhưng body là:

```json
{
  "status": "done"
}
```

Không nên dùng cách này nếu task cha có nhiều sub-task, vì có thể đóng task cha khi các sub-task khác chưa xong.

### 12.5 Thứ tự node khuyến nghị trong workflow HR/KT

```text
Webhook HR/KT
-> Fake Answer hoặc AI Agent
-> Tạo file báo cáo
-> Comment thành công trên task con
-> PATCH task con = done
-> GET task con lấy parentId
-> POST comment vào task cha
-> PATCH task cha = in_review
-> Respond to Webhook
```

Nếu muốn tự động đóng task cha:

```text
Webhook HR/KT
-> xử lý task con
-> tạo báo cáo
-> PATCH task con = done
-> GET task con lấy parentId
-> POST comment vào task cha
-> PATCH task cha = done
-> Respond to Webhook
```

## 13. Kết luận ngắn để đưa vào báo cáo

Paperclip không tự động coi task cha là hoàn thành chỉ vì sub-task đã `done`. Task cha đóng vai trò điều phối và nghiệm thu, còn sub-task là đơn vị thực thi. Vì vậy cần bổ sung một bước chốt vòng đời task cha sau khi agent con hoàn thành.

Phương án phù hợp nhất cho demo là:

```text
Agent con hoàn thành sub-task
-> tạo report/document
-> cập nhật sub-task = done
-> comment kết quả vào task cha
-> chuyển task cha = in_review
-> CEO/người dùng nghiệm thu và chuyển task cha = done
```

Nếu muốn demo tự động khép kín, agent con có thể cập nhật task cha thẳng sang `done`, nhưng chỉ nên dùng khi chắc chắn task cha chỉ có một sub-task.
