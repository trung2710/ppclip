# Dùng lại session khi comment vào task cũ: tổng hợp thay đổi code

Ngày: 22/10/2026. Nhánh: `test_adapter`. Tác giả commit: trung2710.

Gồm 4 commit liên tiếp (16:27 đến 16:36). Mục tiêu chung: khi comment vào một task cũ, agent **dùng lại đúng session (thread Codex) cũ** thay vì mở thread mới, và vẫn ghi/đóng task được.

| Commit | Giờ | Tiêu đề | Tệp | Dòng |
| --- | --- | --- | --- | --- |
| `9484bc8d8` | 16:27 | stop hashing issue.updated_at into the session config fingerprint | 2 | +108 −20 |
| `ce5f44f62` | 16:35 | fingerprint a model profile only when it is applied | 2 | +70 −1 |
| `cdc715f16` | 16:36 | exclude per-run scratch dir env from the session fingerprint | 2 mới | +82 |
| `612535f46` | 16:36 | start the agent with the current run's env when resuming a session | 3 | +100 −1 |

## 1. Cơ chế nền

- Cuối mỗi run, agent `persistent` lưu mã session. Run sau nạp lại (resume) để giữ hội thoại.
- Trước khi resume, server so **dấu vân tay cấu hình** (fingerprint) của lần trước với lần này. Khác nhau thì bỏ session cũ và ghi log:
  `Skipping saved session resume ... because effective run configuration changed: <nhóm>`.
  Danh sách nhóm đổi nằm ở `result_json.configFreshness.changedCategories`.
- Server (`server/src/services/heartbeat.ts`) tính fingerprint theo 11 nhóm: `adapter`, `adapterConfig`, `agentRuntimeConfig`, `modelProfile`, `instructions`, `issueOverrides`, `workspaceConfig`, `environment`, `envBindings`, `secrets`, `runtimeSkills`.
- Engine ACPX (`packages/adapter-utils/src/acpx-engine/execute.ts`) có thêm fingerprint riêng của session ACPX, trong đó `adapterEnvHash` là mã băm của toàn bộ env đã giải của adapter.
- Nguyên tắc: fingerprint chỉ được đổi khi cấu hình **thật sự** đổi. Giá trị đổi ở mọi run (nhiễu) làm session bị bỏ mỗi lần.

## 2. Bốn nguyên nhân và cách sửa

### 2.1. `issues.updated_at` làm nhóm `workspaceConfig` đổi liên tục (`9484bc8d8`)

**Triệu chứng:** task được mở lại bằng comment, mọi run đều ghi `changed: workspace config`, `changedCategories: ["workspaceConfig"]`, mỗi comment sinh một thread Codex mới.

**Nguyên nhân:** `workspaceConfig` chứa `issueConfigRevisionAt` lấy từ `issues.updated_at`. Cột này đổi ở mọi comment, đổi trạng thái, checkout, kể cả comment do chính agent đăng trong run. Fingerprint lưu cuối run vì thế không bao giờ khớp lần đánh thức kế tiếp.

**Sửa** (`heartbeat.ts`): thêm hàm export `buildSessionWorkspaceConfigFingerprintInput`, nhận
`requestedMode`, `effectiveMode`, `projectUpdatedAt`, `projectPolicy`, `issueSettings`, `reusableExecutionWorkspaceConfig`, `existingExecutionWorkspace`
và trả về
`{ requestedMode, effectiveMode, projectConfigRevisionAt (ISO), projectPolicy, issueSettings, reusableExecutionWorkspaceConfig, existingExecutionWorkspace }`,
trong đó `existingExecutionWorkspace` là `{ id, mode, strategyType, projectWorkspaceId, repoUrl, baseRef, branchName, config }` hoặc `null`.

- **Không còn mốc thời gian của issue.**
- Giữ `projectConfigRevisionAt` vì chỉ đổi khi project bị sửa.
- Cấu hình workspace thật của issue vẫn được tính qua `issueSettings` (và nhóm `issueOverrides`), nên không mất tín hiệu.

**Test** (`server/src/__tests__/heartbeat-workspace-session.test.ts`, mô tả "session fingerprint noise", 3 test):
1. Mốc thời gian của issue không bao giờ vào mã băm.
2. Vẫn reset khi workspace settings thật của issue đổi.
3. Vẫn reset khi project bị sửa.

### 2.2. Model profile được yêu cầu nhưng không áp dụng (`ce5f44f62`)

**Triệu chứng:** log `changed: model profile`; fingerprint nhảy `null → cheap → null` giữa các run.

**Nguyên nhân:** nhóm `modelProfile` băm cả metadata (`requested`, `requestedBy`, `applied`, `configSource`, `fallbackReason`). Wake `source_scoped_recovery_action` yêu cầu profile `cheap`, nhưng agent đã tắt profile đó (`fallbackReason: agent_runtime_profile_disabled`, `applied: null`). Run vẫn dùng model thường, nhưng metadata khác các run không yêu cầu gì.

**Sửa** (`heartbeat.ts`): thêm `buildSessionModelProfileFingerprintInput(metadata)`.

```ts
const applied = readNonEmptyString(metadata?.applied);
if (!applied) return null;
return { applied, configSource: readNonEmptyString(metadata?.configSource) };
```

Chỗ dựng metadata phiên đổi thành `modelProfile: buildSessionModelProfileFingerprintInput(modelProfileMetadata)`.
Khi profile được áp dụng, phần ghi đè của nó đã nằm trong `adapterConfig`; `applied` và `configSource` giữ lại để vẫn phát hiện việc chuyển giữa hai profile đã áp dụng. Profile chỉ được yêu cầu thì coi như không có profile.

**Test** (2): yêu cầu nhưng không áp dụng thì fingerprint không đổi; profile được áp dụng xuất hiện hoặc chuyển profile thì vẫn reset.

### 2.3. Thư mục scratch riêng của từng run nằm trong `adapterEnvHash` (`cdc715f16`)

**Triệu chứng:** log `config fingerprint changed: adapterEnvHash` và `starting fresh` ở mọi run.

**Nguyên nhân:** server ghi thư mục scratch (tạo bằng `mkdtemp`, khác nhau mỗi run) vào env của adapter qua `PAPERCLIP_RUN_SCRATCH_DIR`, `PAPERCLIP_TASK_SCRATCH_DIR`, `PAPERCLIP_SCRATCH_DIR`, `PAPERCLIP_TMPDIR`, và vào `TMPDIR`/`TEMP`/`TMP` khi người dùng để trống. Engine băm cả các giá trị đó.

**Sửa:** tệp mới `packages/adapter-utils/src/acpx-engine/fingerprint-env.ts`, hàm `stripRunScopedEnvForFingerprint(env)`:

```ts
const scratchDir = env.PAPERCLIP_RUN_SCRATCH_DIR ?? env.PAPERCLIP_SCRATCH_DIR ?? null;
return Object.fromEntries(
  Object.entries(env).filter(([key, value]) => {
    if (RUN_SCRATCH_ENV_KEYS.has(key)) return false;
    return !(scratchDir && value === scratchDir);
  }),
);
```

Trong `execute.ts`: `adapterEnvHash: shortHash(stripRunScopedEnvForFingerprint(resolvedAdapterEnv))`.
Giá trị **vẫn được truyền cho agent**, chỉ bị loại khỏi mã băm. `TMPDIR`/`TEMP`/`TMP` do người dùng tự cấu hình (ổn định giữa các run) vẫn nằm trong mã băm.

**Test** (`fingerprint-env.test.ts`, 4): hai run chỉ khác scratch dir cho cùng kết quả; env cấu hình đổi thật vẫn bị nhận ra; `TMPDIR` của người dùng được giữ; không làm gì khi server không tạo scratch dir.

### 2.4. Resume nhưng agent chạy với env của run đầu tiên (`612535f46`)

**Triệu chứng:** mọi thao tác ghi bị từ chối với `Issue run ownership conflict` hoặc `agent_jwt_run_id_mismatch`; agent không comment hay đóng task được.

**Nguyên nhân:** acpx lưu `sessionOptions.env` của run tạo session trong bản ghi trên đĩa, và các lần `ensureSession` sau trả lại bản ghi đó nguyên vẹn. Env của Paperclip gắn theo run: `PAPERCLIP_API_KEY` là JWT ràng buộc với mã run, `PAPERCLIP_RUN_ID` là mã run. Lượt resume vì thế gọi API với danh nghĩa run cũ.

**Sửa:** tệp mới `packages/adapter-utils/src/acpx-engine/session-refresh.ts`, hàm `requestFreshClientForResume(store, sessionKey)`:

```ts
const record = await store.load(sessionKey).catch(() => undefined);
if (!record || record.acpx?.reset_on_next_ensure === true) return false;
record.acpx = { ...record.acpx, reset_on_next_ensure: true };
await store.save(record);
return true;
```

`reset_on_next_ensure` là cờ **có sẵn của acpx**: ở `ensureSession` kế tiếp acpx bỏ bản ghi đã lưu, khởi động agent với env của **run hiện tại**, rồi nối lại cùng thread bằng `session/resume` hoặc `session/load` (hội thoại được giữ).

Gọi trong `execute.ts`, ngay trước `ensureSession`:

```ts
if (!handle && resumeSessionId && prepared.mode === "persistent") {
  await requestFreshClientForResume(runtimeOptions.sessionStore, prepared.sessionKey).catch(() => false);
}
```

Có handle ấm thì bỏ qua (đó là tiến trình của chính run này). Lỗi khi gọi bị nuốt nên không làm hỏng run.

**Test** (`session-refresh.test.ts`, 4): đặt cờ cho bản ghi đang có; không làm gì khi không có bản ghi; không ghi lại bản ghi đã có cờ; kho không đọc được coi như không có bản ghi.

## 3. Luồng sau khi sửa

1. Comment vào task cũ, server đánh thức agent bằng run mới.
2. Server tính fingerprint: `workspaceConfig` không còn mốc thời gian issue, `modelProfile` chỉ tính khi có profile được áp dụng. Không có thay đổi thật thì khớp, giữ mã session.
3. Engine ACPX tính fingerprint session với `adapterEnvHash` đã bỏ scratch dir. Khớp thì có session để resume.
4. Trước `ensureSession`, đặt cờ `reset_on_next_ensure`.
5. acpx khởi động agent với env của run hiện tại, nối lại cùng thread.
6. Agent làm việc trong hội thoại cũ, gọi API bằng mã run mới, nên comment và đóng task không bị lỗi ownership.

Ba commit đầu chỉ làm session **không bị bỏ oan**. Commit thứ tư là bắt buộc đi kèm: nếu chỉ giữ session mà không làm mới env thì sẽ lộ lỗi ownership.

Session vẫn bị bỏ khi có thay đổi thật: workspace settings của issue đổi, project bị sửa, profile được áp dụng hoặc chuyển profile, env cấu hình đổi.

## 4. Kiểm chứng

- Chạy ngày 22/10/2026: `fingerprint-env.test.ts`, `session-refresh.test.ts`, `heartbeat-workspace-session.test.ts` cho **132 test đạt** (gồm cả test có sẵn; 13 test mới = 3 + 2 + 4 + 4).
- Thông điệp commit `612535f46` ghi: trên một run thật, lượt resume giữ nguyên mã session, ghi bằng mã run mới, kết thúc không có lỗi ownership. Đây là thông tin từ commit message, chưa được chạy lại trong lần tổng hợp này.

## 5. Chưa kiểm chứng

- Chưa thử end to end trên luồng Telegram và n8n (comment vào task cũ của agent Front-Desk).
- Chưa đo tỷ lệ session được dùng lại qua nhiều run.
- Chưa kiểm tra agent không ở chế độ `persistent` và trường hợp handle ấm.
- Giữ hội thoại cũ làm ngữ cảnh dài hơn; ảnh hưởng tới thời gian run và chi phí chưa được đo.
