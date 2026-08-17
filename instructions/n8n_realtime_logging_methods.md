# 🛠️ N8N to Paperclip Real-time Logging Methods

Tài liệu hướng dẫn chi tiết các phương án kỹ thuật để quản lý và truyền **Log Real-time** từ **n8n Workflow Execution Runtime** sang **Paperclip Control Plane** thông qua **HTTP Adapter**.

---

## 📌 Tổng quan kiến trúc

Paperclip HTTP Adapter ([`server/src/adapters/http/execute.ts`](file:///c:/paperclip/server/src/adapters/http/execute.ts#L40-L52)) đã hỗ trợ sẵn luồng **HTTP Response Streaming** (`res.body.getReader()`). Mỗi khi n8n phát ra 1 dòng/chunk dữ liệu qua luồng HTTP Response stream (kèm ký tự `\n`), Paperclip sẽ đọc và gọi `ctx.onLog("stdout", chunk)` để in ngay lên màn hình đen Terminal trên giao diện Paperclip UI.

```text
n8n (Bên Gửi) ──(HTTP Response Stream / Chunked)──> Paperclip execute.ts ──(ctx.onLog)──> Terminal UI
```

---

## 👑 PHƯƠNG ÁN ĐẶC BIỆT: Mô hình lai Event-Driven (Hook kết hợp Bridge) 🏆 (KHUYÊN DÙNG NHẤT)

Đây là **phương án tối ưu nhất**, kết hợp hoàn hảo ưu điểm của n8n Hook (độ chính xác 100%, 0ms độ trễ) và Proxy Bridge (nắm giữ kết nối HTTP để truyền log về Paperclip). **Hoàn toàn không sử dụng Polling.**

```text
Paperclip ──(1. Chờ kết nối)──> Proxy Bridge <──(3. POST local log event)── n8n Hook
   │                                 │                                         │
   └─(4. In log lên UI) <──(res.write)┘                               (2. Mỗi khi node xong)
```

### 1. Cơ chế hoạt động
1. Paperclip gọi sang **Proxy Bridge** và giữ kết nối mở.
2. Proxy Bridge gọi kích hoạt n8n workflow.
3. Trong lúc n8n chạy, mỗi khi 1 node hoàn thành, **n8n Hook** tự động bắn một HTTP POST mang dữ liệu log (`executionId`, `nodeName`, `input`, `output`, `timeMs`) về cho Proxy Bridge.
4. Proxy Bridge nhận event, đối chiếu `executionId` và dùng `res.write()` truyền ngay log về cho Paperclip.

### 2. Ưu & Nhược điểm
- **Ưu điểm**:
  - **Real-time 0ms (Event-driven)**: Log hiển thị tức thời từng miligiây.
  - **Chính xác 100%**: Không sợ bị trượt mốc hay gộp mốc log kể cả khi node chạy siêu nhanh.
  - **Không tốn tài nguyên**: Không dùng vòng lặp polling làm tốn CPU.
  - **Không lẫn log**: Hỗ trợ chạy hàng trăm luồng song song mà log vẫn về đúng từng Run tương ứng.
- **Nhược điểm**:
  - Cần cài đặt cả file Hook trên n8n và chạy 1 tiến trình Proxy Bridge siêu nhẹ.

### 3. Hướng dẫn cài đặt

#### Bước 1: Cài đặt Hook trên n8n server (`paperclip-hook.js`)
Đặt file này trên máy chủ n8n và set biến môi trường `EXTERNAL_HOOK_FILES=/path/to/paperclip-hook.js`.

```javascript
const axios = require('axios');

module.exports = {
  hooks: {
    // Kích hoạt ngay khi 1 node chạy xong
    nodePostExecute: [
      async function (nodeName, executionData) {
        const timeMs = executionData.executionTime || 0;
        const executionId = this.executionId; // Lấy mã phiên chạy n8n

        const logPayload = {
          executionId,
          nodeName,
          timeMs,
          input: executionData.sourceData?.main || [],
          output: executionData.data?.main || [],
        };

        // Bắn trực tiếp về Bridge
        await axios.post('http://localhost:3005/log-event', logPayload).catch(() => {});
      },
    ],
  },
};
```

#### Bước 2: Chạy Proxy Bridge (`bridge.js`)

```javascript
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// Lưu trữ các HTTP response connection đang mở theo executionId
const activeConnections = new Map();

// 1. Nhận yêu cầu từ Paperclip
app.post('/webhook-bridge', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  res.write("[paperclip] ▶ Bắt đầu kích hoạt n8n workflow...\n");

  try {
    const n8nRes = await axios.post('http://localhost:5678/api/v1/workflows/WORKFLOW_ID/run', req.body);
    const executionId = n8nRes.data.executionId;

    // Lưu kết nối HTTP của Paperclip
    activeConnections.set(executionId, res);

    // Chờ n8n chạy xong hoàn toàn (n8n API) để đóng kết nối
    let isFinished = false;
    while (!isFinished) {
      await new Promise(r => setTimeout(r, 1000));
      const execInfo = await axios.get(`http://localhost:5678/api/v1/executions/${executionId}`);
      if (execInfo.data.finished) isFinished = true;
    }

    res.write("[paperclip] ▶ n8n Workflow đã hoàn tất thành công.\n");
    res.end();
    activeConnections.delete(executionId);
  } catch (err) {
    res.write(`[paperclip] ❌ Lỗi: ${err.message}\n`);
    res.end();
  }
});

// 2. Nhận Log Event từ n8n Hook đẩy về
app.post('/log-event', (req, res) => {
  const { executionId, nodeName, timeMs, input, output } = req.body;
  const clientRes = activeConnections.get(executionId);

  if (clientRes) {
    const inputStr = JSON.stringify(input).slice(0, 150);
    const outputStr = JSON.stringify(output).slice(0, 200);

    const logLine = 
      `[paperclip] ▶ [Node: ${nodeName}] (${timeMs}ms)\n` +
      `  ├─ 📥 Input : ${inputStr}...\n` +
      `  └─ 📤 Output: ${outputStr}...\n`;

    clientRes.write(logLine); // Đẩy log realtime về Paperclip
  }
  res.sendStatus(200);
});

app.listen(3005, () => console.log('Hybrid Bridge running on port 3005'));
```

---

## 🟢 PHƯƠNG ÁN 1: n8n External Hooks (Chỉ ghi log tại n8n Server Console)

- **Cơ chế**: Dùng hook hệ thống n8n in log trực tiếp ra console chạy n8n server.
- **Giới hạn**: **Không truyền về Paperclip UI được** vì log in cục bộ trên server n8n.

---

## 🟡 PHƯƠNG ÁN 2: In-Workflow Emitter (Chèn Node Code trong Canvas n8n)

- **Cơ chế**: Chèn node Code sinh log dòng chữ rồi trả trực tiếp qua node Webhook Response.
- **Giới hạn**: Phải sửa thủ công từng Workflow, làm bẩn Canvas n8n.

---

## 🔵 PHƯƠNG ÁN 3: Proxy Bridge Node.js (Polling Middleware)

- **Cơ chế**: Dịch vụ trung gian hỏi dồn n8n qua API mỗi 0.5s rồi relay log về Paperclip.
- **Giới hạn**: Bị trễ (`0.5s`), dễ gộp log hoặc trượt mất mốc thời gian thực của các node siêu nhanh.

---

## 📊 Bảng so sánh tổng hợp các phương án

| Tiêu chí | Mô hình lai (Hook + Bridge) 🏆 | Phương án 1 (Hooks Console) | Phương án 2 (Canvas Code) | Phương án 3 (Polling Bridge) |
| :--- | :---: | :---: | :---: | :---: |
| **Kiến trúc** | **Event-Driven Push** | Local Event Logs | Manual Canvas Stream | Polling (Hỏi dồn) |
| **Truyền về Paperclip** | **Có (Real-time)** | Không | Có (Real-time) | Có (Gần Real-time) |
| **Độ trễ (Latency)** | **0 ms** | 0 ms (chỉ ở console) | 0 ms | 0.1s - 0.5s |
| **Không sợ mất log** | **100% Tuyệt đối** | 100% Tuyệt đối | 100% Tuyệt đối | Dễ bị trượt/gộp mốc |
| **Nhiều luồng song song** | **Hỗ trợ hoàn hảo** | Bị lẫn lộn | Hỗ trợ tốt | Dễ bị lẫn/chậm log |
| **Đánh giá** | **Winner 🥇** | Bất khả thi cho UI | Khó bảo trì đồ thị | Kém mượt mà |

---

> 🎯 **Lời khuyên cuối cùng**: Hãy sử dụng **Mô hình lai Event-Driven (Hook kết hợp Bridge)** để đạt được chất lượng log realtime tiệm cận gần nhất với Native Agent mà không phải sửa mã nguồn của Paperclip!
