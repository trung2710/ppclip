# Hướng Dẫn & Phân Tích Cơ Chế Quản Trị Ngân Sách (Budget Governance) Trong Paperclip

Tài liệu này giải thích chi tiết chức năng **Budget (Ngân sách)** của AI Agent trên giao diện Paperclip, cách thức mã nguồn backend kiểm soát chi phí trong thời gian thực, cơ chế bảo vệ chống "cháy ví" (Circuit Breaker), và quy trình vận hành khi kết hợp với **LiteLLM Proxy**.

---

## 1. Tổng Quan Về Tính Năng Budget

Trong các hệ thống AI Agent tự trị (Autonomous Agents), rủi ro lớn nhất về mặt chi phí là **vòng lặp vô tận (Infinite ReAct Loops)** — khi model gặp lỗi hoặc hiểu sai chỉ thị, nó có thể liên tục gọi tool, đọc ghi file hoặc gửi request hàng trăm lần trong thời gian ngắn, gây phát sinh chi phí Cloud khổng lồ.

Tính năng **Budget Governance** trong Paperclip được sinh ra như một **chốt chặn an toàn (Circuit Breaker)**:
* **Kiểm soát đa cấp độ (Multi-scope):** Có thể áp ngân sách cho từng **Agent riêng lẻ**, từng **Project**, hoặc toàn bộ **Company**.
* **Chu kỳ ngân sách chuẩn quốc tế (Monthly UTC):** Tự động tính toán theo lịch tháng UTC (từ 00:00:00 ngày đầu tháng đến hết tháng theo giờ UTC) và tự động làm mới (reset) sang chu kỳ mới.
* **Bảo vệ 2 lớp (Two-tiered Protection):** Cảnh báo mềm khi chạm ngưỡng (Soft Alert) và ngắt cứng lập tức khi chạm trần (Hard Stop).

```
                      Chi tiêu thực tế (OBSERVED)
 0% ────────────────────────── 80% ──────────────────────── 100%
  │                             │                             │
[OK: Hoạt động bình thường]   [SOFT ALERT: Cảnh báo vàng]   [HARD STOP: Khóa Agent đỏ]
                               • Gửi thông báo                • Chuyển trạng thái sang Paused
                               • Agent vẫn chạy tiếp          • Hủy ngay Task / Heartbeat dở
                               • Tạo Incident Soft            • Tạo phiếu duyệt Approval
```

---

## 2. Giải Thích Các Thông Số Trên Giao Diện Agent > Budget

| Thông số trên UI | Ý nghĩa & Bản chất kỹ thuật |
| :--- | :--- |
| **Monthly UTC budget** | **Chu kỳ ngân sách theo tháng UTC**: Bắt đầu từ 00:00 ngày 1 hàng tháng đến 23:59 ngày cuối tháng (giờ chuẩn UTC). Hết tháng, số tiền quan sát (`OBSERVED`) tự động về lại `$0.00`. |
| **OBSERVED: $0.00** *(0% of limit)* | **Tổng chi phí thực tế đã tiêu trong tháng này**: Backend truy vấn tổng `SUM(costCents)` từ bảng `costEvents` của riêng Agent này trong tháng UTC hiện tại. *(Nếu hiện `$0.00` dù Agent đã chạy nhiều token, lý do là vì Adapter đang trả `costUsd: null`)*. |
| **BUDGET: $5.00** | **Hạn mức trần (Cap limit)**: Số tiền tối đa được phép chi tiêu trong 1 tháng (lưu trong DB dưới đơn vị Cents: `500 cents`). |
| **Soft alert at 80%** | **Ngưỡng cảnh báo sớm (Mặc định 80% = $4.00)**: Khi chi phí chạm mốc này, hệ thống sẽ cảnh báo cho Admin biết ngân sách sắp cạn. |
| **Remaining: $5.00** | **Số dư ngân sách còn lại**: `BUDGET - OBSERVED`. Khi con số này về `$0.00`, chốt chặn Hard Stop sẽ được kích hoạt. |
| **Ô nhập liệu & [Update budget]** | Nơi Admin thiết lập lại hạn mức (ví dụ nâng từ $5.00 lên $10.00). |

---

## 3. Kiến Trúc & Cơ Chế Kiểm Soát Sâu Trong Mã Nguồn

Toàn bộ logic kiểm soát ngân sách được triển khai tập trung tại các file cốt lõi của backend Paperclip:

### 3.1. Kích hoạt kiểm tra sau mỗi Run (`costs.ts`)
* **File:** [`server/src/services/costs.ts:89`](file:///c:/paperclip/server/src/services/costs.ts#L89)
* **Cơ chế:** Khi Agent kết thúc 1 Run (1 Heartbeat), dữ liệu chi phí được lưu vào bảng `costEvents`. Ngay lập tức, hàm đánh giá thời gian thực được gọi:
  ```typescript
  await budgets.evaluateCostEvent(event);
  ```

---

### 3.2. Đánh giá thời gian thực & Hai cấp độ xử lý (`budgets.ts`)
* **File:** [`server/src/services/budgets.ts`](file:///c:/paperclip/server/src/services/budgets.ts) (hàm `evaluateCostEvent`, dòng 649-715).

```
[Hoàn thành Run] ──> [Ghi costEvent] ──> [Tính tổng observedAmount]
                                                    │
                 ┌──────────────────────────────────┴──────────────────────────────────┐
                 ▼ (observed >= 80%)                                                   ▼ (observed >= 100%)
         [CẤP 1: SOFT ALERT]                                                   [CẤP 2: HARD STOP]
         • Tạo budgetIncidents (soft)                                          • Đóng soft incidents
         • Ghi activityLog: soft_threshold_crossed                             • Tạo budgetIncidents (hard)
         • Agent VẪN CHẠY BÌNH THƯỜNG                                          • Cập nhật agents.status = 'paused'
                                                                               • agents.pauseReason = 'budget'
                                                                               • Hủy tiến trình / Heartbeat đang chạy
                                                                               • Tạo phiếu duyệt 'budget_override_required'
```

#### Cấp độ 1: Soft Alert (Mặc định 80% = $4.00)
```typescript
const softThreshold = Math.ceil((policy.amount * policy.warnPercent) / 100);

if (policy.notifyEnabled && observedAmount >= softThreshold) {
  // Tạo sự cố mức soft nếu chưa có:
  const softIncident = await createIncidentIfNeeded(policy, "soft", observedAmount);
  if (softIncident?.created) {
    await logActivity(db, {
      companyId: policy.companyId,
      actorType: "system",
      actorId: "budget_service",
      action: "budget.soft_threshold_crossed",
      entityType: "budget_incident",
      entityId: softIncident.incident.id,
      details: { amountObserved: observedAmount, amountLimit: policy.amount },
    });
  }
}
```
* **Đặc điểm:** Không ngắt quãng công việc của Agent, chỉ cảnh báo để quản trị viên có kế hoạch bổ sung ngân sách.

#### Cấp độ 2: Hard Stop (Chạm ngưỡng 100% = $5.00)
```typescript
if (policy.hardStopEnabled && observedAmount >= policy.amount) {
  await resolveOpenSoftIncidents(policy.id);
  // 1. Tạo sự cố mức Hard Stop và sinh phiếu phê duyệt:
  const hardIncident = await createIncidentIfNeeded(policy, "hard", observedAmount);
  
  // 2. KHÓA TỨC THÌ VÀ HỦY TIẾN TRÌNH:
  await pauseAndCancelScopeForBudget(policy);
}
```

Trong hàm `pauseScopeForBudget` ([dòng 248](file:///c:/paperclip/server/src/services/budgets.ts#L248)):
1. **Khóa Agent trong Database:**
   ```typescript
   await db.update(agents)
     .set({
       status: "paused",
       pauseReason: "budget", // Ghi rõ lý do tạm dừng là do chạm ngân sách
       pausedAt: now,
       updatedAt: now,
     })
     .where(and(eq(agents.id, policy.scopeId), inArray(agents.status, ["active", "idle", "running", "error"])));
   ```
2. **Hủy tiến trình đang chạy:** Gọi hook `cancelWorkForScope` để ngắt ngay các phiên chạy CLI / Heartbeat đang dang dở.
3. **Sinh phiếu phê duyệt khẩn cấp (Approval):**
   ```typescript
   await db.insert(approvals).values({
     companyId: policy.companyId,
     type: "budget_override_required",
     status: "pending",
     payload: {
       scopeType: "agent",
       scopeName: "Codex",
       budgetAmount: 500, // 5.00 USD
       observedAmount: 502,
       guidance: "Raise the budget and resume the scope, or keep the scope paused.",
     },
   });
   ```

---

## 4. Mối Liên Hệ Giữa Budget Và LiteLLM Proxy

Hiện tượng bạn đang thấy trên màn hình:
* **OBSERVED hiển thị `$0.00`** dù Agent đã thực hiện nhiều tác vụ.

### Nguyên nhân:
1. Codex Adapter mặc định không có thông tin chi phí từ API Cloud, nên trả về `costUsd: null` tại [`packages/adapters/codex-local/src/server/execute.ts:1349`](file:///c:/paperclip/packages/adapters/codex-local/src/server/execute.ts#L1349).
2. Khi `costUsd` là `null`, hàm `normalizeBilledCostCents` chuyển thành `0 cents` và lưu vào `costEvents`.
3. Khi hàm tính toán ngân sách `computeObservedAmount` chạy, kết quả `SUM(costCents)` trả về `0`, dẫn đến `OBSERVED` luôn bằng `$0.00`.

### Khi kết nối LiteLLM Proxy:
1. LiteLLM tự động tính toán chính xác chi phí của từng turn và trả về trong response body:
   ```json
   { "usage": { "prompt_tokens": 1200, "completion_tokens": 300, "cost": 0.00045 } }
   ```
2. Adapter của Paperclip đọc `cost` này gán thẳng vào `costUsd`.
3. Heartbeat đổi sang Cents và ghi vào `costEvents`.
4. **Hệ thống Budget tự động kích hoạt:**
   - Cột `OBSERVED` sẽ tăng dần theo từng xu chi tiêu thực tế.
   - Thanh tiến trình hiển thị tỷ lệ % trực quan.
   - Khi vượt $4.00, cờ cảnh báo vàng xuất hiện.
   - Khi chạm $5.00, Agent sẽ tự động chuyển sang `paused` để bảo vệ tài khoản của bạn.

---

## 5. Quy Trình Khôi Phục & Mở Khóa Khi Agent Bị Hard Stop

Khi một Agent chạm ngưỡng ngân sách và bị chuyển sang trạng thái `paused (budget)`, bạn có 2 cách để mở khóa cho Agent tiếp tục làm việc:

### Cách 1: Nâng hạn mức ngân sách trực tiếp trên tab Budget (Khuyên dùng)
1. Truy cập vào **Agents > [Tên Agent] > Tab Budget**.
2. Tại ô **BUDGET (USD)**, nhập hạn mức mới (ví dụ: `10.00`).
3. Bấm nút **Update budget**.
4. **Hệ thống tự động xử lý ngầm ([`server/src/services/budgets.ts:275`](file:///c:/paperclip/server/src/services/budgets.ts#L275)):**
   - Cập nhật hạn mức mới vào bảng `budgetPolicies`.
   - Hàm `resumeScopeFromBudget` tự động kiểm tra nếu hạn mức mới > chi phí đã tiêu (`amount > observedAmount`), nó sẽ tự động cập nhật Agent:
     ```typescript
     await db.update(agents).set({
       status: "idle",       // Đổi từ paused về idle
       pauseReason: null,    // Xóa lý do budget
       pausedAt: null,
     }).where(and(eq(agents.id, policy.scopeId), eq(agents.pauseReason, "budget")));
     ```
   - Đóng toàn bộ các `budgetIncidents` đang mở liên quan đến sự cố này.
   - Agent lập tức sẵn sàng nhận Task hoặc Heartbeat tiếp theo mà không cần khởi động lại server.

### Cách 2: Phê duyệt thông qua mục Approvals
1. Truy cập vào mục **Approvals** trên menu chính của Paperclip.
2. Tìm phiếu duyệt có tiêu đề **Budget Override Required** của Agent tương ứng.
3. Bấm **Approve** và điều chỉnh hạn mức theo hướng dẫn. Hệ thống sẽ giải phóng trạng thái paused của Agent.
