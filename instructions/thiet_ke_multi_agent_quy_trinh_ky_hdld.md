# Thiết Kế Hệ Thống Multi-Agent: Quy Trình Ký Mới Hợp Đồng Lao Động (HĐLĐ)

> **Tài liệu tham chiếu:** Sơ đồ quy trình BPMN chuẩn tại [`QLHD.pdf`](file:///C:/paperclip/instructions/QLHD.pdf)  
> **Nền tảng triển khai:** Paperclip Core Orchestrator + n8n Runtime Adapter

---

## 1. Bối Cảnh & Mục Tiêu Nghiệp Vụ

Quy trình **Ký mới Hợp đồng Lao động (HĐLĐ)** sau giai đoạn thử việc là một quy trình kinh điển trong quản trị nhân sự, bao gồm sự phối hợp liên phòng ban qua nhiều bước xét duyệt, phân nhánh điều kiện và bảo đảm tính pháp lý của văn bản.

### Mục tiêu chuyển đổi sang Multi-Agent:
- **Tự động hóa hoàn toàn luồng điều phối:** Không cần nhân viên nhân sự phải thủ công gửi email, tạo task hay nhắc việc từng cấp.
- **Phân định rõ ràng trách nhiệm của từng Agent (Separation of Concerns):** Mỗi Agent đảm nhiệm đúng một vai trò nghiệp vụ (HRBP đánh giá, Manager phê duyệt, Văn thư đóng dấu, Contract Worker điều phối).
- **Rẽ nhánh thông minh dựa trên kết quả:** Tự động phát hiện kết quả đánh giá thử việc (**Đạt** hoặc **Không đạt**) để tạo hợp đồng mới hoặc biên bản thanh lý tương ứng.
- **Minh bạch và bảo mật:** Toàn bộ lịch sử duyệt, đóng dấu, ý kiến trao đổi đều được lưu trữ theo Audit Log và Document Versioning của Paperclip.

---

## 2. Thiết Kế Đội Ngũ Agent (Agent Roles & Org Structure)

Hệ thống được chia làm 4 Agent chính trên Paperclip tương ứng với các làn bơi (Swimlanes) trong sơ đồ BPMN:

| Agent Name | Vai trò trong BPMN | Loại Agent | Trách nhiệm chính |
| :--- | :--- | :--- | :--- |
| **`Contract Agent`** | **Contract Worker** *(Chủ quản luồng)* | Điều phối (Orchestrator) | Quản lý Task cha, tiếp nhận danh sách hết hạn thử việc, sinh sub-task cho các Agent khác, theo dõi tiến độ và nghiệm thu cuối cùng. |
| **`HRBP Agent`** | **HRBP / HR VSS** | Nghiệp vụ Chuyên môn | Thu thập dữ liệu thử việc, đánh giá năng lực nhân sự, ký nháy chuyên môn, cập nhật cơ sở dữ liệu nhân sự (HRIS). |
| **`Manager Agent`** | **Manager (Quản lý trực tiếp)** | Phê duyệt (Approval) | Ký duyệt kết quả đánh giá thử việc, phê duyệt việc ký kết HĐLĐ chính thức. |
| **`Clerk Agent`** | **Văn thư** | Pháp lý / Lưu trữ | Đóng dấu pháp lý (Digital Stamp/Watermark) lên HĐLĐ sau khi đủ chữ ký, lưu trữ và phát hành văn bản. |

*(Lưu ý: Vai trò **Nhân viên (Người lao động)** có thể mô phỏng tự động qua Mock AI/Code Node hoặc tích hợp tương tác Người - Máy qua Paperclip User Interaction).*

---

## 3. Cây Phân Cấp Task (Task Hierarchy & State Flow)

Mỗi hồ sơ nhân sự hết hạn thử việc sẽ được biểu diễn bằng một **Task cha (Parent Task)** và các **Sub-task con tuần tự/song song**:

```
[Task Cha: Quy trình ký mới HĐLĐ - Nguyễn Văn A - T08/2026] (Contract Agent)
   │
   ├── GIAI ĐOẠN 1: Thu Thập & Ký Duyệt Đánh Giá Thử Việc
   │      │
   │      └── [Sub-Task 1: Đánh giá kết quả thử việc]
   │             ├── Assignee: HRBP Agent (Thu thập KPI, lập đánh giá)
   │             └── Assignee: Manager Agent (Ký duyệt kết quả: "ĐẠT" / "KHÔNG ĐẠT")
   │             └── Output Document: "Báo cáo đánh giá thử việc"
   │
   ├── GIAI ĐOẠN 2: Rẽ Nhánh Thực Thi Theo Kết Quả
   │      │
   │      ├── [NHÁNH A: ĐẠT THỬ VIỆC] (Ký mới HĐLĐ)
   │      │      ├── [Sub-Task 2A: Trình ký HĐLĐ mới]
   │      │      │      ├── Nhân viên ký duyệt
   │      │      │      ├── HRBP Agent ký duyệt
   │      │      │      └── Manager Agent ký duyệt
   │      │      │      └── Output Document: "HĐLĐ_NguyenVanA_Signed.md"
   │      │      │
   │      │      └── [Sub-Task 2B: Đóng dấu & Phát hành HĐLĐ]
   │      │             ├── Assignee: Clerk Agent (Văn thư)
   │      │             └── Output: Đóng dấu đỏ điện tử & Lưu trữ
   │      │
   │      └── [NHÁNH B: KHÔNG ĐẠT THỬ VIỆC] (Thanh lý hợp đồng)
   │             ├── [Sub-Task 3A: Ký Biên bản thanh lý (BBTL)]
   │             │      └── Nhân viên & Manager ký thanh lý
   │             └── [Sub-Task 3B: Cập nhật hồ sơ & Thông báo nghỉ việc]
   │                    └── Assignee: HRBP Agent
   │
   └── GIAI ĐOẠN 3: Nghiệm Thu Hoàn Tất
          └── Contract Agent thức dậy -> Kiểm tra văn bản đã đóng dấu -> Gửi thông báo hoàn tất -> PATCH Task cha = DONE.
```

---

## 4. Chi Tiết Các Giai Đoạn Vận Hành (Step-by-Step Flow)

### 📌 Giai đoạn 1: Lập danh sách & Đánh giá thử việc
1. **Contract Agent (Lượt 1):**
   * Nhận danh sách nhân sự đến hạn thử việc.
   * Tạo **Task Cha** (Status: `in_progress`).
   * Tạo **Sub-Task 1** giao cho `HRBP Agent` và `Manager Agent` đánh giá.
   * Gọi `PATCH` Task cha sang `status: "blocked"` kèm `blockedByIssueIds: [subTask1Id]`.
   * Contract Agent kết thúc Run 1 (ngủ chờ).
2. **HRBP Agent & Manager Agent:**
   * HRBP đọc KPIs, dữ liệu làm việc $\rightarrow$ Viết bản đánh giá vào Paperclip Document.
   * Manager duyệt và ghi nhận quyết định: `"Đạt"` hoặc `"Không đạt"`.
   * Cập nhật Sub-Task 1 sang `status: "done"`.

---

### 📌 Giai đoạn 2: Phân nhánh xử lý kết quả
1. **Contract Agent (Lượt 2 - Thức dậy khi Sub-Task 1 done):**
   * Nhận `wakeReason: "issue_blockers_resolved"`.
   * Đọc Document kết quả từ Sub-Task 1:
     * **Trường hợp 1 (ĐẠT):**
       - Tạo file dự thảo HĐLĐ mới.
       - Tạo **Sub-Task 2A** (Trình ký HĐLĐ 3 bên: Nhân viên $\rightarrow$ HRBP $\rightarrow$ Manager).
       - Tạo **Sub-Task 2B** (Đóng dấu - giao cho Clerk Agent).
       - Cập nhật Task cha sang `status: "blocked"` kèm `blockedByIssueIds: [subTask2AId, subTask2BId]`.
     * **Trường hợp 2 (KHÔNG ĐẠT):**
       - Tạo dự thảo Biên bản thanh lý (BBTL).
       - Tạo **Sub-Task 3A** (Ký BBTL) và **Sub-Task 3B** (Cập nhật HRIS nghỉ việc).
       - Cập nhật Task cha sang `status: "blocked"` kèm `blockedByIssueIds: [subTask3AId, subTask3BId]`.

---

### 📌 Giai đoạn 3: Ký duyệt & Đóng dấu văn bản (Nhánh Đạt)
1. **Nhân viên & HRBP & Manager:**
   * Thực hiện ký duyệt điện tử vào Document HĐLĐ trên Paperclip.
   * Hoàn thành Sub-Task 2A (`status: "done"`).
2. **Clerk Agent (Văn thư):**
   * Nhận Sub-Task 2B khi Sub-Task 2A xong.
   * Kiểm tra đầy đủ 3 chữ ký $\rightarrow$ Thêm con dấu mộc đỏ công ty (Digital Watermark Stamp).
   * Cập nhật Document cuối cùng: `HĐLĐ_ChinhThuc_DaDongDau.pdf`.
   * Hoàn thành Sub-Task 2B (`status: "done"`).

---

### 📌 Giai đoạn 4: Nghiệm thu & Chốt Task cha
1. **Contract Agent (Lượt 3 - Thức dậy sau khi Văn thư đóng dấu xong):**
   * Nhận `wakeReason: "issue_blockers_resolved"` hoặc `"issue_children_completed"`.
   * Kiểm tra file HĐLĐ đã có dấu hợp lệ.
   * Gửi comment thông báo hoàn tất toàn bộ quy trình cho HR và Nhân viên.
   * Gọi `PATCH /api/issues/{parentTaskId}` với `status: "done"`.
   * Toàn bộ quy trình hoàn tất mỹ mãn!

---

## 5. Thiết Kế Chi Tiết API & Webhook n8n

### 5.1. Cấu hình API Task Cha (`Contract Agent`)
* **Tạo Sub-task con:**
  * **Method:** `POST`
  * **URL:** `http://host.docker.internal:3100/api/companies/{companyId}/issues`
  * **Body:**
    ```json
    {
      "title": "Sub-Task: Đánh giá thử việc - Nguyễn Văn A",
      "description": "HRBP và Manager thực hiện đánh giá năng lực thử việc",
      "status": "todo",
      "priority": "high",
      "parentId": "{{ $('Contract_Agent').item.json.body.taskId }}",
      "assigneeAgentId": "<ID_CUA_HRBP_AGENT>"
    }
    ```

* **Khóa Task Cha vào trạng thái chờ:**
  * **Method:** `PATCH`
  * **URL:** `http://host.docker.internal:3100/api/issues/{{ $('Contract_Agent').item.json.body.taskId }}`
  * **Headers:** `x-paperclip-run-id: {{ $('Contract_Agent').item.json.body.runId }}`
  * **Body:**
    ```json
    {
      "status": "blocked",
      "blockedByIssueIds": [
        "{{ $('Tạo Sub-Task 1').item.json.id }}"
      ],
      "comment": "Task cha chuyển sang trạng thái chờ do đang đợi đánh giá thử việc."
    }
    ```

---

### 5.2. Cấu hình API Lưu Văn Bản / Hợp Đồng (`Documents API`)
* **Method:** `PUT`
* **URL:** `http://host.docker.internal:3100/api/issues/{issueId}/documents/{docKey}`
* **Headers:** `x-paperclip-run-id: {runId}`
* **Body:**
  ```json
  {
    "title": "Hợp Đồng Lao Động Chính Thức",
    "format": "markdown",
    "body": "# HỢP ĐỒNG LAO ĐỘNG\n\n**Bên A:** Công ty KH02 Technology\n**Bên B:** Ông/Bà Nguyễn Văn A\n\n## Điều 1: Thời hạn hợp đồng\n- Loại hợp đồng: Xác định thời hạn 12 tháng...",
    "baseRevisionId": null
  }
  ```

---

### 5.3. Cấu hình API Hoàn Tất Task Con
* **Method:** `PATCH`
* **URL:** `http://host.docker.internal:3100/api/issues/{subTaskId}`
* **Headers:** `x-paperclip-run-id: {runId}`
* **Body:**
  ```json
  {
    "status": "done",
    "comment": "Đã hoàn thành đánh giá / ký duyệt văn bản."
  }
  ```

---

## 6. Lộ Trình Triển Khai Thực Tế

```text
[Giai đoạn 1]                [Giai đoạn 2]                [Giai đoạn 3]                [Giai đoạn 4]
Khởi tạo 4 Agent trên       Xây dựng Workflow            Xây dựng Workflow            Kiểm thử End-to-End
Paperclip (Lấy Agent ID,    n8n cho Contract Agent       cho HRBP, Manager,           và Tinh chỉnh Log /
Cấp API Bearer Tokens)      & Nhánh phân tích rẽ nhánh   Clerk (Đóng dấu)             Document Preview UI
```

---

## 7. Xử Lý Batch: Nhiều Hợp Đồng Cùng Lúc (Batch Dispatcher Pattern)

### 7.1. Bài toán thực tế

Cuối mỗi tháng, phòng nhân sự sẽ có **danh sách hàng chục nhân viên hết hạn thử việc** cùng lúc (ví dụ: 20 nhân viên trong tháng 08/2026). Luồng ký HĐLĐ ở trên là thiết kế cho **1 nhân viên / 1 hợp đồng**.

> **Quy tắc thiết kế cốt lõi:** Mỗi nhân viên = 1 Task Cha độc lập trên Paperclip. KHÔNG gộp chung nhiều người vào 1 task.

### 7.2. Tại Sao Phải Tách Mỗi Người 1 Task Cha Riêng?

| Tiêu chí | ✅ Tách mỗi NV 1 Task Cha | ❌ Gộp chung tất cả vào 1 Task |
| :--- | :--- | :--- |
| **Tiến độ** | Độc lập: Người nào xong trước chốt trước, không chờ nhau. | Bị nghẽn: 1 người chưa ký là cả danh sách bị kẹt lại. |
| **Độ phức tạp n8n** | Đơn giản: Tái sử dụng nguyên vẹn luồng 1 người. | Rất phức tạp: Phải lọc mảng, xử lý rẽ nhánh cho từng phần tử JSON. |
| **Bảo mật & Lưu trữ** | Chuẩn: Mỗi NV có 1 bộ tài liệu HĐ riêng biệt. | Dễ nhầm: Dồn toàn bộ HĐ vào 1 chỗ, dễ lộ thông tin lương/KPI. |
| **Xử lý lỗi (Error Handling)** | Cô lập: 1 HĐ lỗi không ảnh hưởng 19 HĐ còn lại. | Domino: Lỗi 1 người có thể làm crash cả danh sách. |

### 7.3. Kiến Trúc "Batch Dispatcher" Workflow

Tạo thêm **1 Workflow Dispatcher riêng** trên n8n, chỉ làm 1 nhiệm vụ duy nhất: Đọc danh sách và tạo Task Cha trên Paperclip cho từng nhân viên.

```text
[Trigger: Lịch định kỳ ngày 25 hàng tháng] hoặc [Upload File Excel thủ công]
                         │
                         ▼
        ┌──────────────────────────────────────┐
        │  Node 1: Đọc File Excel / Google Sheet│
        │  Lấy danh sách nhân viên hết hạn TV   │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────┐
        │  Node 2: Loop Over Items (n8n)        │
        │  Lặp qua từng dòng trong danh sách   │
        └──────────────┬───────────────────────┘
                       │ (Mỗi vòng lặp = 1 nhân viên)
                       ▼
        ┌──────────────────────────────────────┐
        │  Node 3: HTTP Request                 │
        │  POST /api/companies/{id}/issues      │
        │  Tạo 1 Task Cha trên Paperclip        │
        │  Body:                                │
        │  {                                    │
        │    "title": "Ký mới HĐLĐ - {ho_ten}",│
        │    "description": "Mã NV: {ma_nv}...",│
        │    "assigneeAgentId": "<ContractAgent>│
        │    "status": "todo"                   │
        │  }                                    │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────┐
        │  Node 4: Respond / Kết thúc vòng lặp │
        └──────────────────────────────────────┘
```

Ngay sau khi Node 3 tạo xong mỗi Task Cha, Paperclip sẽ **tự động kích hoạt Contract Agent** (wakeReason: `issue_assigned`) và cả 20 luồng HĐLĐ sẽ **chạy song song hoàn toàn độc lập** với nhau!

### 7.4. Cấu Hình Node "Loop Over Items" Trong n8n

```
┌─────────────────────────────────────────────────────────┐
│ Node: Loop Over Items                                    │
│ - Batch Size: 1 (Xử lý từng người 1, không gộp batch)  │
│ - Input: Danh sách từ node Đọc Excel                    │
│ - Output: Từng item đơn lẻ sang node tạo Task Cha       │
└─────────────────────────────────────────────────────────┘
```

**Body mẫu cho Node tạo Task Cha (Expression mode `=[...]`):**
```json
{
  "title": "Quy trình ký mới HĐLĐ - {{ $json.ho_va_ten }} - T{{ $now.month }}/{{ $now.year }}",
  "description": "Mã NV: {{ $json.ma_nhan_vien }}\nPhòng ban: {{ $json.phong_ban }}\nNgày hết hạn thử việc: {{ $json.ngay_het_han_tv }}\nMức lương đề xuất: {{ $json.muc_luong_de_xuat }}",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "<ID_CONTRACT_AGENT>"
}
```

---

## 8. Luồng Con: Theo Dõi & Nhắc Ký Duyệt Văn Bản (Monitoring + Reminder Loop)

### 8.1. Mô Tả Nghiệp Vụ

Trong quy trình ký HĐLĐ, sau khi văn bản được trình lên người duyệt (Manager, HRBP, Nhân viên...), có thể xảy ra tình trạng **người duyệt chưa thực hiện do bận hoặc quên**. Hệ thống cần tự động:

1. **Định kỳ kiểm tra** xem văn bản đã được ký duyệt đầy đủ chưa.
2. **Gửi thông báo nhắc** đến người chịu trách nhiệm nếu chưa hoàn thành.
3. **Ghi nhận từ chối** nếu người duyệt từ chối ký → kích hoạt luồng xử lý ngoại lệ.

```text
[Văn bản đang trong luồng ký]
           │
           ▼
  [Kiểm tra tình trạng văn bản] ◄──────────────────────┐
           │                                             │
           ▼ (Decision)                                  │
    ┌──────┴──────┐                                      │
    │             │                                      │
 Hoàn thành   Chưa hoàn thành        Từ chối            │
    │             │                    │                 │
    ▼             ▼                    ▼                 │
(Tiếp luồng)  [Gửi thông báo nhắc]  [Xử lý ngoại lệ]  │
              [Đặt lịch kiểm tra lại] ─────────────────►┘
```

### 8.2. Cách 1: Dùng Paperclip Issue Monitor (Đơn Giản - Khuyên Dùng Trước)

Paperclip hỗ trợ sẵn cơ chế **`monitorNextCheckAt`**: Agent có thể đặt lịch tự đánh thức lại vào một thời điểm cụ thể để kiểm tra lại trạng thái.

**Trong n8n Workflow của Agent phụ trách luồng ký (HRBP Agent / Contract Agent):**

```text
[Webhook nhận run từ Paperclip]
           │
           ▼
[Node: Kiểm tra Document HĐLĐ]
GET /api/issues/{subTaskId}/documents
- Đọc nội dung Document hợp đồng
- Đếm số chữ ký / xác nhận đã có
           │
           ▼ (If: Đủ chữ ký?)
    ┌──────┴────────┐
    │               │
   ĐỦ            CHƯA ĐỦ
    │               │
    ▼               ▼
PATCH done     [POST /comments: "Nhắc: Còn thiếu chữ ký của Manager"]
               [PATCH task: monitorNextCheckAt = +4 giờ]
               [Respond to Webhook → Agent ngủ lại]
               [Paperclip tự đánh thức lại sau 4 giờ!]
```

**Payload cho node PATCH khi chưa đủ chữ ký:**
```json
{
  "comment": "Nhắc lần {{ $json.lan_nhac }}: Vui lòng ký duyệt HĐLĐ trước 08:00 ngày {{ $json.han_chot }}. Còn thiếu chữ ký của: {{ $json.nguoi_con_thieu }}.",
  "monitorNextCheckAt": "{{ $json.thoi_diem_kiem_tra_lai }}"
}
```

### 8.3. Cách 2: Dùng n8n Schedule Trigger (Giám Sát Tổng Thể)

Tạo thêm **1 Workflow Monitoring riêng** chạy định kỳ, quét toàn bộ các HĐLĐ đang trong luồng ký:

```text
[Trigger: Mỗi ngày lúc 08:00 và 14:00]
           │
           ▼
[GET /api/companies/{id}/issues]
Params: status=blocked, assigneeAgentId=<ID_HRBP_hoac_Manager>
(Lấy tất cả sub-task đang chờ ký)
           │
           ▼
[Loop Over Items] (Mỗi sub-task đang pending)
           │
           ▼
[Đọc Document → Kiểm tra số chữ ký]
           │
    ┌──────┴──────┐
    │             │
 Đủ chữ ký   Chưa đủ
    │             │
    ▼             ▼
PATCH done    POST comment nhắc
              PATCH monitorNextCheckAt (+8h)
              [Gửi email/Zalo OA/Slack thông báo]
```

### 8.4. So Sánh 2 Cách Theo Dõi Vòng Lặp

| Tiêu chí | ✅ Cách 1: Paperclip Monitor | 🔧 Cách 2: n8n Schedule |
| :--- | :--- | :--- |
| **Độ phức tạp** | Rất đơn giản, chỉ thêm 1 field vào PATCH | Cần tạo thêm 1 workflow mới |
| **Linh hoạt tần suất** | Mỗi HĐ có thể có lịch nhắc khác nhau | Tất cả theo cùng 1 lịch cố định |
| **Giám sát nhiều HĐ cùng lúc** | Mỗi HĐ tự quản lý riêng | 1 workflow quét toàn bộ |
| **Gửi thông báo ngoài (Slack/Email)** | Cần tích hợp thêm trong Agent workflow | Dễ tích hợp trực tiếp trong n8n |
| **Phù hợp bắt đầu** | ✅ Dùng trước để prototype nhanh | Dùng sau khi hệ thống ổn định |

> **Khuyến nghị thực tế:** Bắt đầu bằng **Cách 1** (monitorNextCheckAt) để prototype nhanh và hoạt động đúng. Sau khi vận hành ổn định với 1-2 tháng, bổ sung thêm **Cách 2** như một lớp giám sát tổng thể bổ sung để có dashboard và cảnh báo tập trung.

---

## 9. Cấu Trúc Phân Cấp Nhiệm Vụ 3 Cấp (3-Tier Task Hierarchy)

Để tối ưu hóa giao diện hiển thị trên Paperclip và quản lý tiến độ hiệu quả cho các chiến dịch nhân sự lớn, hệ thống áp dụng cấu trúc phân cấp nhiệm vụ 3 cấp liên kết chặt chẽ thông qua thuộc tính `parentId`:

### 9.1. Sơ Đồ Phân Cấp (Task Tree)

```text
CẤP 1: TASK CHA TỔNG (Chiến dịch định kỳ theo tháng)
└── [Task Cha Tổng: Xét duyệt thử việc Tháng 08/2026] (Contract Worker Agent - Dispatcher)
      │
      ├── CẤP 2: TASK CHI TIẾT TỪNG NHÂN VIÊN (Tạo ra từ file CSV)
      │     ├── [Task Con: Quy trình ký mới HĐLĐ - Nguyễn Văn A] (Contract Agent - Điều phối)
      │     │     │
      │     │     ├── CẤP 3: CÁC SUB-TASK THỰC THI (Luồng 3 Giai Đoạn của Nguyễn Văn A)
      │     │     │     ├── [Sub-Task 1: Đánh giá thử việc] (HRBP & Manager)
      │     │     │     ├── [Sub-Task 2A: Trình ký HĐLĐ mới] (Nhân viên, HRBP, Manager)
      │     │     │     └── [Sub-Task 2B: Đóng dấu & Phát hành] (Clerk Agent)
      │     │
      │     └── [Task Con: Quy trình ký mới HĐLĐ - Lê Thị B] (Contract Agent - Điều phối)
      │           │
      │           └── CẤP 3: CÁC SUB-TASK THỰC THI (Luồng 3 Giai Đoạn của Lê Thị B)
      │                 ├── [Sub-Task 1: Đánh giá thử việc]...
      │                 └── ...
```

### 9.2. Chi Tiết Các Cấp Nhiệm Vụ

#### 1. Cấp 1: Task Cha Tổng (Super Parent Task / Batch Campaign Task)
*   **Mô tả:** Đại diện cho toàn bộ chiến dịch xét duyệt của cả tháng. Chứa file CSV danh sách nhân viên hết hạn thử việc được đính kèm.
*   **Trách nhiệm:** Tạo ra thủ công bởi HR hoặc tự động qua scheduler. Được giao cho **Contract Worker Agent** (Dispatcher).
*   **Quy tắc liên kết:** Không có `parentId` (hoặc là gốc cao nhất).

#### 2. Cấp 2: Task Chi Tiết Từng Nhân Viên (Employee Level Task)
*   **Mô tả:** Đại diện cho toàn bộ luồng quy trình của **một nhân viên cụ thể**.
*   **Trách nhiệm:** Tạo ra tự động bởi n8n Dispatcher sau khi đọc và duyệt dữ liệu trong CSV. Được giao cho **Contract Agent** (Orchestrator).
*   **Quy tắc liên kết:** Khởi tạo với thuộc tính `"parentId": "{ID_Task_Cha_Tổng_Cấp_1}"`.

#### 3. Cấp 3: Các Sub-task Thực Thi (Action Level Tasks)
*   **Mô tả:** Các bước thực tế như thu thập đánh giá, trình ký HĐLĐ, đóng dấu văn thư.
*   **Trách nhiệm:** Tạo ra tự động bởi Contract Agent (luồng n8n con) tương ứng với từng giai đoạn và rẽ nhánh. Được giao cho các Agent chuyên môn (**HRBP Agent**, **Manager Agent**, **Clerk Agent**...).
*   **Quy tắc liên kết:** Khởi tạo với thuộc tính `"parentId": "{ID_Task_Chi_Tiết_Nhân_Viên_Cấp_2}"`.

### 9.3. Lợi Ích Quản Trị
*   **Giao diện sạch sẽ:** Tránh việc hiển thị dàn trải hàng trăm sub-task nhỏ lẻ trên bảng Kanban/Board chính. Chỉ hiển thị Task Cấp 1 hoặc Cấp 2.
*   **Tự động hóa đóng luồng:** Khi toàn bộ các Task Cấp 3 hoàn thành, Task Cấp 2 (Nhân viên) sẽ đóng. Khi tất cả các Task Cấp 2 đóng, Task Cấp 1 (Chiến dịch tháng) sẽ tự động được đánh dấu hoàn tất.

---

*Tài liệu được biên soạn tự động để phục vụ xây dựng hệ thống tự động hóa nhân sự trên nền tảng Paperclip.*
